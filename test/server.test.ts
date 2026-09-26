import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { memory, type MemoryTransport } from '../src/index.js'
import type { MemoryQueue } from '../src/queue/index.js'
import { createMailServer, type Logger, type MailServer } from '../src/server/index.js'

const KEY = 'rvrox-test-key-0123456789abcdef'
const OTHER = 'other-test-key-0123456789abcdef'
const LIMITED = 'limited-test-key-0123456789abcd'
const quiet: Logger = { info() {}, warn() {}, error() {} }

describe('servidor HTTP', () => {
  let server: MailServer
  let base: string
  let hostinger: MemoryTransport
  let resendMock: MemoryTransport

  beforeAll(async () => {
    hostinger = memory({ name: 'hostinger' })
    resendMock = memory({ name: 'resend' })
    server = await createMailServer({
      port: 0,
      trustProxy: true,
      logger: quiet,
      transports: { hostinger, resend: resendMock },
      defaultTransport: 'hostinger',
      from: 'RVROX <info@paramoprograming.com>',
      templates: {
        welcome: { subject: 'Welcome {{name}}', html: '<p>Hi {{name}}, {{plan}}</p>' },
      },
      apiKeys: [
        { id: 'rvrox', key: KEY, allowedFrom: ['@paramoprograming.com'] },
        { id: 'other', key: OTHER },
        { id: 'limited', key: LIMITED, transport: 'resend', rateLimit: { max: 3, windowMs: 60_000 } },
      ],
      forms: {
        inquiry: {
          to: 'owner@gmail.com',
          subject: 'New inquiry from {{name}}',
          allowedOrigins: ['https://rvroxminitrack.com'],
          honeypot: 'website',
          rateLimit: { max: 2, windowMs: 60_000 },
          redirect: { success: 'https://rvroxminitrack.com/thanks', error: 'https://rvroxminitrack.com/oops' },
          fields: {
            name: { required: true, maxLength: 20 },
            email: { type: 'email', required: true },
            service: { type: 'select', options: ['Decks', 'Grading'] },
            message: { type: 'textarea', required: true },
          },
        },
      },
    })
    const address = (await server.listen())!
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(() => server.close())

  const drain = () => (server.queue as MemoryQueue).drain()
  const api = (path: string, body: unknown, key = KEY) =>
    fetch(base + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const form = (body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(base + '/v1/forms/inquiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://rvroxminitrack.com', ...headers },
      body: JSON.stringify(body),
    })

  it('/health', async () => {
    const res = await fetch(base + '/health')
    expect(await res.json()).toMatchObject({ ok: true, transports: ['hostinger', 'resend'] })
  })

  describe('/v1/send', () => {
    it('exige API key', async () => {
      expect((await api('/v1/send', {}, 'mala')).status).toBe(401)
      expect((await fetch(base + '/v1/send', { method: 'POST' })).status).toBe(401)
    })

    it('encola y envía con plantilla; el trabajo se consulta por id', async () => {
      const res = await api('/v1/send', { to: 'ana@x.com', template: 'welcome', data: { name: 'Ana', plan: '<Pro>' } })
      expect(res.status).toBe(202)
      const { id } = (await res.json()) as { id: string }
      expect(id).toMatch(/^rvrox\./)
      await drain()
      const sent = hostinger.sent.at(-1)!
      expect(sent.subject).toBe('Welcome Ana')
      expect(sent.html).toBe('<p>Hi Ana, &lt;Pro&gt;</p>')

      const job = await fetch(`${base}/v1/jobs/${id}`, { headers: { Authorization: `Bearer ${KEY}` } })
      expect(await job.json()).toMatchObject({ id, status: 'completed', result: { transport: 'hostinger' } })
      // Otra clave no ve los trabajos ajenos.
      expect((await fetch(`${base}/v1/jobs/${id}`, { headers: { Authorization: `Bearer ${OTHER}` } })).status).toBe(404)
    })

    it('valida el mensaje antes de encolar', async () => {
      const bad = await api('/v1/send', { to: 'no-email', subject: 's', text: 't' })
      expect(bad.status).toBe(400)
      expect(await bad.json()).toMatchObject({ code: 'INVALID_ADDRESS' })
      expect((await api('/v1/send', { to: 'a@x.com', subject: 's' })).status).toBe(400)
      expect((await api('/v1/send', { to: 'a@x.com', template: 'nope' })).status).toBe(400)
      const many = Array.from({ length: 51 }, (_, i) => `u${i}@x.com`)
      expect((await api('/v1/send', { to: many, subject: 's', text: 't' })).status).toBe(400)
    })

    it('aplica allowedFrom de la clave', async () => {
      const res = await api('/v1/send', { from: 'ceo@gmail.com', to: 'a@x.com', subject: 's', text: 't' })
      expect(res.status).toBe(403)
      expect((await api('/v1/send', { from: 'ventas@paramoprograming.com', to: 'a@x.com', subject: 's', text: 't' })).status).toBe(202)
    })

    it('fuerza el transporte de la clave y aplica su rate limit', async () => {
      const before = resendMock.sent.length
      const results = []
      for (let i = 0; i < 4; i++) results.push((await api('/v1/send', { to: 'a@x.com', subject: 's', text: 't', transport: 'hostinger' }, LIMITED)).status)
      expect(results).toEqual([202, 202, 202, 429])
      await drain()
      expect(resendMock.sent.length - before).toBe(3)
    })

    it('idempotencyKey evita duplicados', async () => {
      const before = hostinger.sent.length
      const body = { to: 'a@x.com', subject: 'pedido', text: 't', idempotencyKey: 'order:42' }
      const a = (await (await api('/v1/send', body)).json()) as { id: string }
      const b = (await (await api('/v1/send', body)).json()) as { id: string }
      expect(a.id).toBe(b.id)
      await drain()
      expect(hostinger.sent.length - before).toBe(1)
    })
  })

  describe('/v1/batch', () => {
    it('campaña: plantilla con datos por destinatario, informa los inválidos', async () => {
      const before = hostinger.sent.length
      const res = await api('/v1/batch', {
        template: 'welcome',
        data: { plan: 'Basic' },
        recipients: [
          { to: 'a@x.com', data: { name: 'Ana' } },
          { to: 'invalid', data: { name: 'X' } },
          { to: 'b@x.com', data: { name: 'Beto', plan: 'Pro' } },
        ],
      })
      expect(res.status).toBe(202)
      const body = (await res.json()) as { queued: unknown[]; errors: Array<{ index: number }> }
      expect(body.queued).toHaveLength(2)
      expect(body.errors.map((e) => e.index)).toEqual([1])
      await drain()
      const sent = hostinger.sent.slice(before).map((m) => m.html).sort()
      expect(sent).toEqual(['<p>Hi Ana, Basic</p>', '<p>Hi Beto, Pro</p>'])
    })
  })

  describe('/v1/forms/:id', () => {
    const valid = { name: 'Jane', email: 'jane@client.com', service: 'Decks', message: 'Need a deck.\nSoon.' }

    it('preflight CORS solo para orígenes permitidos', async () => {
      const ok = await fetch(base + '/v1/forms/inquiry', { method: 'OPTIONS', headers: { Origin: 'https://rvroxminitrack.com' } })
      expect(ok.status).toBe(204)
      expect(ok.headers.get('access-control-allow-origin')).toBe('https://rvroxminitrack.com')
      const evil = await fetch(base + '/v1/forms/inquiry', { method: 'OPTIONS', headers: { Origin: 'https://evil.com' } })
      expect(evil.headers.get('access-control-allow-origin')).toBeNull()
    })

    it('envía el formulario con Reply-To al visitante y escapa el HTML', async () => {
      const before = hostinger.sent.length
      const tooLong = await form({ ...valid, name: 'x'.repeat(21) }, { 'X-Real-IP': '10.0.0.1' })
      expect(tooLong.status).toBe(400)
      const ok = await form({ ...valid, name: 'Jane <b>' }, { 'X-Real-IP': '10.0.0.1' })
      expect(ok.status).toBe(200)
      await drain()
      const mail = hostinger.sent.slice(before).at(-1)!
      expect(mail.to[0]!.address).toBe('owner@gmail.com')
      expect(mail.replyTo?.address).toBe('jane@client.com')
      expect(mail.subject).toBe('New inquiry from Jane <b>')
      expect(mail.html).toContain('Jane &lt;b&gt;')
      expect(mail.text).toContain('Message:\nNeed a deck.\nSoon.')
    })

    it('valida campos, origen, honeypot y rate limit por IP', async () => {
      const ip = { 'X-Real-IP': '10.0.0.2' }
      const noEmail = await form({ ...valid, email: 'x' }, ip)
      expect(noEmail.status).toBe(400)
      expect(await noEmail.json()).toMatchObject({ error: 'Email must be a valid email address.', fields: { email: expect.any(String) } })
      expect((await form({ ...valid, service: 'Hacking' }, ip)).status).toBe(400)
      expect((await form(valid, { ...ip, Origin: 'https://evil.com' })).status).toBe(403)

      const before = hostinger.sent.length
      expect((await form({ ...valid, website: 'spam' }, ip)).status).toBe(200)
      await drain()
      expect(hostinger.sent.length).toBe(before)

      expect((await form(valid, ip)).status).toBe(200)
      expect((await form(valid, ip)).status).toBe(200)
      expect((await form(valid, ip)).status).toBe(429)
      expect((await form(valid, { 'X-Real-IP': '10.0.0.3' })).status).toBe(200)
    })

    it('formulario HTML sin JS: redirige con 303', async () => {
      const res = await fetch(base + '/v1/forms/inquiry', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://rvroxminitrack.com', 'X-Real-IP': '10.0.0.4' },
        body: new URLSearchParams(valid).toString(),
      })
      expect(res.status).toBe(303)
      expect(res.headers.get('location')).toBe('https://rvroxminitrack.com/thanks')
    })
  })

  it('404 y cuerpo inválido', async () => {
    expect((await fetch(base + '/nada')).status).toBe(404)
    const res = await fetch(base + '/v1/send', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: '{roto' })
    expect(res.status).toBe(400)
  })
})

describe('configuración', () => {
  it('rechaza API keys cortas o sin clave', async () => {
    const base = { logger: quiet, transports: { m: memory({ name: 'm' }) } }
    await expect(createMailServer({ ...base, apiKeys: [{ id: 'x', key: 'corta' }] })).rejects.toThrow(/24 caracteres/)
    await expect(createMailServer({ ...base, apiKeys: [{ id: 'x' }] })).rejects.toThrow(/key o keyHash/)
  })
})
