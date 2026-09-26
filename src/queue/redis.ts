import { createHash, randomUUID } from 'node:crypto'
import { MailerError, isRetryable } from '../errors.js'
import type { Mailer } from '../mailer.js'
import type { MessageInput, SendResult } from '../types.js'
import type {
  AddOptions,
  JobInfo,
  JobStatus,
  MailQueue,
  QueueEvents,
  QueueOptions,
  WorkerOptions,
} from './types.js'

/** `redis://…` / `rediss://…`, o las opciones de conexión de ioredis. */
export type RedisConnection = string | Record<string, unknown>

export interface RedisQueueOptions extends QueueOptions {
  connection: RedisConnection
  /** Nombre de la cola; separa proyectos que comparten Redis. Por defecto "mail". */
  name?: string
  /** Prefijo de claves en Redis. Por defecto "mailer". */
  prefix?: string
  /** Trabajos terminados que se conservan (por cola). */
  keepCompleted?: number
  keepFailed?: number
}

export interface RedisWorkerOptions extends WorkerOptions {
  connection: RedisConnection
  mailer: Mailer
  name?: string
  prefix?: string
}

export interface RedisWorker {
  on<E extends keyof QueueEvents>(event: E, listener: QueueEvents[E]): this
  close(): Promise<void>
}

type BullMQ = typeof import('bullmq')

async function loadBullMQ(): Promise<BullMQ> {
  try {
    return await import('bullmq')
  } catch (err) {
    throw new MailerError(
      'CONFIG_ERROR',
      'La cola Redis necesita bullmq e ioredis: npm install bullmq ioredis',
      { cause: err },
    )
  }
}

/** ioredis no acepta URL dentro de un objeto de opciones: se desarma aquí. */
export function toConnectionOptions(connection: RedisConnection, forWorker: boolean): Record<string, unknown> {
  let options: Record<string, unknown>
  if (typeof connection === 'string') {
    const url = new URL(connection)
    options = {
      host: url.hostname,
      port: Number(url.port || 6379),
      ...(url.username && { username: decodeURIComponent(url.username) }),
      ...(url.password && { password: decodeURIComponent(url.password) }),
      ...(url.pathname.length > 1 && { db: Number(url.pathname.slice(1)) }),
      ...(url.protocol === 'rediss:' && { tls: {} }),
    }
  } else {
    options = { ...connection }
  }
  // Los workers de BullMQ exigen reintentos infinitos en ioredis; el
  // productor no, para que un Redis caído falle rápido en vez de colgar la API.
  return forWorker ? { ...options, maxRetriesPerRequest: null } : { ...options, enableOfflineQueue: false }
}

// BullMQ no admite ":" en ids propios (lo usa como separador de claves).
const safeJobId = (id: string): string =>
  /^[\w.\-@]{1,200}$/.test(id) ? id : createHash('sha256').update(id).digest('hex')

const STATUS: Record<string, JobStatus> = {
  waiting: 'waiting',
  prioritized: 'waiting',
  'waiting-children': 'waiting',
  delayed: 'delayed',
  active: 'active',
  completed: 'completed',
  failed: 'failed',
}

/** Productor: encola desde la API o desde cualquier app, sin enviar nada. */
export async function createRedisQueue(options: RedisQueueOptions): Promise<MailQueue> {
  const { Queue } = await loadBullMQ()
  const queue = new Queue<MessageInput, SendResult>(options.name ?? 'mail', {
    connection: toConnectionOptions(options.connection, false),
    prefix: options.prefix ?? 'mailer',
    defaultJobOptions: {
      attempts: options.attempts ?? 5,
      backoff: { type: 'exponential', delay: options.backoffMs ?? 2000 },
      removeOnComplete: { count: options.keepCompleted ?? 10_000 },
      removeOnFail: { count: options.keepFailed ?? 10_000 },
    },
  })

  const jobOptions = (message: MessageInput, opts: AddOptions = {}) => ({
    jobId: safeJobId(opts.id ?? message.idempotencyKey ?? randomUUID()),
    ...(opts.delayMs && { delay: opts.delayMs }),
    // En BullMQ la prioridad va de 1 (más alta) en adelante; 0 = sin prioridad.
    ...(opts.priority !== undefined && { priority: Math.max(1, opts.priority + 1) }),
  })

  return {
    async add(message, opts) {
      const job = await queue.add('send', message, jobOptions(message, opts))
      return { id: job.id! }
    },
    async addBulk(items) {
      const jobs = await queue.addBulk(
        items.map(({ message, options: opts }) => ({ name: 'send', data: message, opts: jobOptions(message, opts) })),
      )
      return jobs.map((job) => ({ id: job.id! }))
    },
    async getJob(id) {
      const job = await queue.getJob(safeJobId(id))
      if (!job) return undefined
      const state = await job.getState()
      const info: JobInfo = {
        id: job.id!,
        status: STATUS[state] ?? 'waiting',
        attempts: job.attemptsMade,
        createdAt: job.timestamp,
        ...(job.returnvalue && { result: job.returnvalue }),
        ...(job.failedReason && { error: { message: job.failedReason } }),
        ...(job.finishedOn && { finishedAt: job.finishedOn }),
      }
      return info
    },
    async counts() {
      const c = await queue.getJobCounts('waiting', 'prioritized', 'delayed', 'active', 'completed', 'failed')
      return {
        waiting: (c.waiting ?? 0) + (c.prioritized ?? 0),
        delayed: c.delayed ?? 0,
        active: c.active ?? 0,
        completed: c.completed ?? 0,
        failed: c.failed ?? 0,
      }
    },
    async close() {
      await queue.close()
    },
  }
}

/**
 * Consumidor: saca correos de Redis y los envía. Se escala arrancando más
 * procesos o máquinas con el mismo `name`; Redis reparte el trabajo y el
 * `limiter` se respeta entre todos.
 */
export async function createRedisWorker(options: RedisWorkerOptions): Promise<RedisWorker> {
  const { Worker, UnrecoverableError } = await loadBullMQ()
  const listeners: { [E in keyof QueueEvents]: QueueEvents[E][] } = { completed: [], failed: [] }

  const worker = new Worker<MessageInput, SendResult>(
    options.name ?? 'mail',
    async (job) => {
      try {
        return await options.mailer.send(job.data)
      } catch (err) {
        // Un error permanente no se reintenta: gastaría intentos y cuota.
        if (!isRetryable(err)) throw new UnrecoverableError((err as Error).message)
        throw err
      }
    },
    {
      connection: toConnectionOptions(options.connection, true),
      prefix: options.prefix ?? 'mailer',
      concurrency: options.concurrency ?? 5,
      ...(options.limiter && { limiter: { max: options.limiter.max, duration: options.limiter.durationMs } }),
    },
  )

  worker.on('completed', (job, result) => {
    const info: JobInfo = {
      id: job.id!,
      status: 'completed',
      attempts: job.attemptsMade,
      createdAt: job.timestamp,
      result,
      finishedAt: Date.now(),
    }
    listeners.completed.forEach((fn) => fn(info))
  })
  worker.on('failed', (job, err) => {
    if (!job) return
    // BullMQ emite "failed" en cada intento; solo interesa el definitivo.
    const final = job.attemptsMade >= (job.opts.attempts ?? 1) || err instanceof UnrecoverableError
    if (!final) return
    const info: JobInfo = {
      id: job.id!,
      status: 'failed',
      attempts: job.attemptsMade,
      createdAt: job.timestamp,
      error: { message: err.message },
      finishedAt: Date.now(),
    }
    listeners.failed.forEach((fn) => fn(info))
  })

  const handle: RedisWorker = {
    on(event, listener) {
      ;(listeners[event] as QueueEvents[typeof event][]).push(listener)
      return handle
    },
    async close() {
      await worker.close()
    },
  }
  return handle
}
