import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { MailerError, isRetryable } from '../errors.js'
import type { Mailer } from '../mailer.js'
import { backoffDelay, sleep } from '../retry.js'
import type { MessageInput } from '../types.js'
import type {
  AddOptions,
  JobInfo,
  JobStatus,
  MailQueue,
  QueueEvents,
  QueueOptions,
  WorkerOptions,
} from './types.js'

export interface MemoryQueueOptions extends QueueOptions, WorkerOptions {
  mailer: Mailer
  /** Trabajos terminados que se recuerdan para `getJob`. Por defecto 1000. */
  keepFinished?: number
}

export interface MemoryQueue extends MailQueue {
  on<E extends keyof QueueEvents>(event: E, listener: QueueEvents[E]): this
  /** Resuelve cuando no quedan trabajos pendientes ni en curso. */
  drain(): Promise<void>
}

interface Job extends JobInfo {
  message: MessageInput
  priority: number
  runAt: number
}

/**
 * Cola en el propio proceso: sin infraestructura, ideal para un servicio
 * pequeño. Se pierde lo pendiente si el proceso se reinicia; para eso,
 * y para repartir entre varias máquinas, usa `createRedisQueue`.
 */
export function createMemoryQueue(options: MemoryQueueOptions): MemoryQueue {
  const { mailer, attempts = 5, backoffMs = 2000, concurrency = 5, keepFinished = 1000, limiter } = options
  const events = new EventEmitter()
  const jobs = new Map<string, Job>()
  const pending: Job[] = []
  const finished: string[] = []
  const starts: number[] = []
  let active = 0
  let closed = false
  let timer: NodeJS.Timeout | undefined
  let idleWaiters: Array<() => void> = []

  const info = ({ message: _m, priority: _p, runAt: _r, ...job }: Job): JobInfo => ({ ...job })

  const checkIdle = () => {
    if (active === 0 && pending.length === 0) {
      idleWaiters.forEach((resolve) => resolve())
      idleWaiters = []
    }
  }

  // Ventana deslizante: cuánto hay que esperar para no pasar de `max` inicios.
  const limiterWait = (): number => {
    if (!limiter) return 0
    const now = Date.now()
    while (starts.length && now - starts[0]! >= limiter.durationMs) starts.shift()
    return starts.length < limiter.max ? 0 : limiter.durationMs - (now - starts[0]!)
  }

  const schedule = (ms: number) => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(pump, Math.max(0, ms))
    timer.unref?.()
  }

  function pump() {
    timer = undefined
    while (!closed && active < concurrency && pending.length) {
      const now = Date.now()
      // Orden: prioridad y luego antigüedad, entre los que ya toca ejecutar.
      let best = -1
      for (let i = 0; i < pending.length; i++) {
        const job = pending[i]!
        if (job.runAt > now) continue
        const current = best === -1 ? undefined : pending[best]!
        if (!current || job.priority < current.priority || (job.priority === current.priority && job.runAt < current.runAt)) {
          best = i
        }
      }
      if (best === -1) {
        schedule(Math.min(...pending.map((j) => j.runAt)) - now)
        return
      }
      const wait = limiterWait()
      if (wait > 0) {
        schedule(wait)
        return
      }
      starts.push(Date.now())
      const [job] = pending.splice(best, 1)
      void run(job!)
    }
  }

  const finish = (job: Job) => {
    job.finishedAt = Date.now()
    finished.push(job.id)
    while (finished.length > keepFinished) jobs.delete(finished.shift()!)
  }

  async function run(job: Job) {
    active++
    job.status = 'active'
    job.attempts++
    try {
      job.result = await mailer.send(job.message)
      job.status = 'completed'
      delete job.error
      finish(job)
      events.emit('completed', info(job))
    } catch (err) {
      const e = err as Error
      job.error = { message: e.message, ...(err instanceof MailerError && { code: err.code }) }
      if (job.attempts < attempts && isRetryable(err) && !closed) {
        job.status = 'delayed'
        job.runAt = Date.now() + backoffDelay(job.attempts, backoffMs, backoffMs * 2 ** 6)
        pending.push(job)
      } else {
        job.status = 'failed'
        finish(job)
        events.emit('failed', info(job))
      }
    } finally {
      active--
      pump()
      checkIdle()
    }
  }

  async function add(message: MessageInput, opts: AddOptions = {}) {
    if (closed) throw new MailerError('CONFIG_ERROR', 'La cola está cerrada')
    const id = opts.id ?? message.idempotencyKey ?? randomUUID()
    if (jobs.has(id)) return { id }
    const now = Date.now()
    const job: Job = {
      id,
      message,
      status: opts.delayMs ? 'delayed' : 'waiting',
      attempts: 0,
      createdAt: now,
      priority: opts.priority ?? 0,
      runAt: now + (opts.delayMs ?? 0),
    }
    jobs.set(id, job)
    pending.push(job)
    schedule(0)
    return { id }
  }

  const queue: MemoryQueue = {
    add,
    async addBulk(items) {
      const out = []
      for (const item of items) out.push(await add(item.message, item.options))
      return out
    },
    async getJob(id) {
      const job = jobs.get(id)
      return job && info(job)
    },
    async counts() {
      const counts: Record<JobStatus, number> = { waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0 }
      for (const job of jobs.values()) counts[job.status]++
      return counts
    },
    on(event, listener) {
      events.on(event, listener)
      return queue
    },
    drain() {
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve)
        checkIdle()
      })
    },
    async close() {
      // Deja terminar lo que está en curso; lo pendiente se descarta.
      closed = true
      if (timer) clearTimeout(timer)
      while (active > 0) await sleep(20)
    },
  }
  return queue
}
