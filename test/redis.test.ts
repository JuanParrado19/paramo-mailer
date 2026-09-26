// Necesita Redis: REDIS_URL=redis://127.0.0.1:6379 npm test
//   docker run --rm -d -p 6379:6379 redis:7-alpine
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MailerError, createMailer, memory, type Message } from '../src/index.js'
import { createRedisQueue, createRedisWorker, type MailQueue, type RedisWorker } from '../src/queue/index.js'

const url = process.env.REDIS_URL

describe.skipIf(!url)('cola Redis (BullMQ)', () => {
  const opened: Array<MailQueue | RedisWorker> = []
  afterAll(async () => {
    for (const x of opened.reverse()) await x.close()
  })

  // Una cola nueva por test: no se pisan entre ejecuciones.
  const setup = async (workerOpts: { concurrency?: number; limiter?: { max: number; durationMs: number } } = {}, fail?: (m: Message) => void) => {
    const name = `test-${randomUUID()}`
    const queue = await createRedisQueue({ connection: url!, name, attempts: 3, backoffMs: 20 })
    const transports = [memory({ name: 'w1', beforeSend: fail }), memory({ name: 'w2', beforeSend: fail })]
    const workers = await Promise.all(
      transports.map((t) =>
        createRedisWorker({ connection: url!, name, mailer: createMailer({ transport: t, from: 'a@b.com', retry: { attempts: 1 } }), ...workerOpts }),
      ),
    )
    opened.push(queue, ...workers)
    return { queue, transports, workers }
  }

  const waitFor = async (check: () => Promise<boolean> | boolean, timeoutMs = 15_000) => {
    const start = Date.now()
    while (!(await check())) {
      if (Date.now() - start > timeoutMs) throw new Error('timeout')
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  it('reparte el trabajo entre varios workers', async () => {
    const { queue, transports } = await setup({ concurrency: 5 })
    await queue.addBulk(Array.from({ length: 200 }, (_, i) => ({ message: { to: `u${i}@x.com`, subject: 's', text: 't' } })))
    await waitFor(async () => (await queue.counts()).completed === 200)
    const [a, b] = transports.map((t) => t.sent.length)
    expect(a! + b!).toBe(200)
    // Ambos procesaron parte: el trabajo se reparte, no lo acapara uno.
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(0)
  })

  it('el limiter es global a todos los workers', async () => {
    const times: number[] = []
    const { queue } = await setup({ concurrency: 10, limiter: { max: 5, durationMs: 500 } }, () => void times.push(Date.now()))
    await queue.addBulk(Array.from({ length: 15 }, (_, i) => ({ message: { to: `u${i}@x.com`, subject: 's', text: 't' } })))
    await waitFor(() => times.length === 15)
    times.sort((x, y) => x - y)
    // 15 envíos a 5 por 500 ms entre los dos workers: al menos ~1 s en total.
    expect(times.at(-1)! - times[0]!).toBeGreaterThanOrEqual(900)
  })

  it('reintenta lo temporal, no lo permanente, y expone el estado', async () => {
    const tries = new Map<string, number>()
    const { queue } = await setup({}, (m) => {
      const to = m.to[0]!.address
      tries.set(to, (tries.get(to) ?? 0) + 1)
      if (to === 'perm@x.com') throw new MailerError('TRANSPORT_ERROR', 'no existe')
      if (to === 'temp@x.com' && tries.get(to)! < 2) throw new MailerError('TRANSPORT_ERROR', 'temporal', { retryable: true })
    })
    const temp = await queue.add({ to: 'temp@x.com', subject: 's', text: 't' })
    const perm = await queue.add({ to: 'perm@x.com', subject: 's', text: 't' })
    await waitFor(async () => (await queue.getJob(temp.id))?.status === 'completed' && (await queue.getJob(perm.id))?.status === 'failed')
    expect(await queue.getJob(temp.id)).toMatchObject({ attempts: 2, result: { accepted: ['temp@x.com'] } })
    expect(await queue.getJob(perm.id)).toMatchObject({ attempts: 1, error: { message: 'no existe' } })
  })

  it('no duplica con el mismo id, aunque tenga caracteres raros', async () => {
    const { queue, transports } = await setup()
    const a = await queue.add({ to: 'a@x.com', subject: 's', text: 't', idempotencyKey: 'order:7' })
    const b = await queue.add({ to: 'a@x.com', subject: 's', text: 't', idempotencyKey: 'order:7' })
    expect(a.id).toBe(b.id)
    await waitFor(async () => (await queue.getJob(a.id))?.status === 'completed')
    await new Promise((r) => setTimeout(r, 200))
    expect(transports.reduce((n, t) => n + t.sent.length, 0)).toBe(1)
  })
})
