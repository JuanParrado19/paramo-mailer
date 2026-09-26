import { describe, expect, it } from 'vitest'
import { MailerError, createMailer, memory, type Message } from '../src/index.js'
import { createMemoryQueue, toConnectionOptions } from '../src/queue/index.js'

const msg = (to: string, extra = {}) => ({ to, subject: 's', text: 't', ...extra })

describe('cola en memoria', () => {
  it('procesa con la concurrencia pedida', async () => {
    let active = 0
    let peak = 0
    const t = memory({
      beforeSend: async () => {
        peak = Math.max(peak, ++active)
        await new Promise((r) => setTimeout(r, 15))
        active--
      },
    })
    const queue = createMemoryQueue({ mailer: createMailer({ transport: t, from: 'a@b.com' }), concurrency: 4 })
    await queue.addBulk(Array.from({ length: 20 }, (_, i) => ({ message: msg(`u${i}@x.com`) })))
    await queue.drain()
    expect(t.sent).toHaveLength(20)
    expect(peak).toBe(4)
    expect(await queue.counts()).toMatchObject({ completed: 20, failed: 0 })
  })

  it('respeta el limiter (máx. N por ventana)', async () => {
    const times: number[] = []
    const t = memory({ beforeSend: () => void times.push(Date.now()) })
    const queue = createMemoryQueue({
      mailer: createMailer({ transport: t, from: 'a@b.com' }),
      concurrency: 10,
      limiter: { max: 3, durationMs: 200 },
    })
    await queue.addBulk(Array.from({ length: 7 }, (_, i) => ({ message: msg(`u${i}@x.com`) })))
    await queue.drain()
    // 7 envíos a 3 por 200 ms: tres ventanas, así que el último sale tras ≥ 400 ms.
    expect(times.at(-1)! - times[0]!).toBeGreaterThanOrEqual(390)
    for (let i = 3; i < times.length; i++) expect(times[i]! - times[i - 3]!).toBeGreaterThanOrEqual(195)
  })

  it('reintenta lo temporal y marca fallido lo permanente', async () => {
    // El contador de intentos de memory() es global; aquí se cuenta por destinatario.
    const tries = new Map<string, number>()
    const t = memory({
      beforeSend: (m: Message) => {
        const to = m.to[0]!.address
        tries.set(to, (tries.get(to) ?? 0) + 1)
        if (to === 'perm@x.com') throw new MailerError('TRANSPORT_ERROR', 'no existe')
        if (to === 'temp@x.com' && tries.get(to)! < 2) throw new MailerError('TRANSPORT_ERROR', 'temporal', { retryable: true })
      },
    })
    const failed: string[] = []
    const queue = createMemoryQueue({
      mailer: createMailer({ transport: t, from: 'a@b.com', retry: { attempts: 1 } }),
      attempts: 5,
      backoffMs: 5,
    }).on('failed', (job) => failed.push(job.id))

    const temp = await queue.add(msg('temp@x.com'))
    const perm = await queue.add(msg('perm@x.com'))
    await queue.drain()

    expect(await queue.getJob(temp.id)).toMatchObject({ status: 'completed', attempts: 2 })
    expect(await queue.getJob(perm.id)).toMatchObject({ status: 'failed', attempts: 1, error: { message: 'no existe', code: 'TRANSPORT_ERROR' } })
    expect(failed).toEqual([perm.id])
  })

  it('no duplica un trabajo con el mismo id / idempotencyKey', async () => {
    const t = memory()
    const queue = createMemoryQueue({ mailer: createMailer({ transport: t, from: 'a@b.com' }) })
    await queue.add(msg('a@x.com', { idempotencyKey: 'pedido-1' }))
    await queue.add(msg('a@x.com', { idempotencyKey: 'pedido-1' }))
    await queue.add(msg('a@x.com'), { id: 'x' })
    await queue.add(msg('a@x.com'), { id: 'x' })
    await queue.drain()
    expect(t.sent).toHaveLength(2)
  })

  it('atiende primero la prioridad más alta y respeta delayMs', async () => {
    const t = memory()
    const queue = createMemoryQueue({ mailer: createMailer({ transport: t, from: 'a@b.com' }), concurrency: 1 })
    // Todo se encola antes de que arranque el primer envío.
    await queue.add(msg('late@x.com'), { delayMs: 80 })
    await queue.add(msg('campaign@x.com'), { priority: 10 })
    await queue.add(msg('urgent@x.com'), { priority: 0 })
    await queue.drain()
    expect(t.sent.map((m) => m.to[0]!.address)).toEqual(['urgent@x.com', 'campaign@x.com', 'late@x.com'])
  })
})

describe('conexión Redis', () => {
  it('desarma URLs redis:// y rediss://', () => {
    expect(toConnectionOptions('rediss://u:p%40ss@redis.example.com:6380/2', true)).toEqual({
      host: 'redis.example.com',
      port: 6380,
      username: 'u',
      password: 'p@ss',
      db: 2,
      tls: {},
      maxRetriesPerRequest: null,
    })
    expect(toConnectionOptions('redis://localhost', false)).toEqual({ host: 'localhost', port: 6379, enableOfflineQueue: false })
  })
})
