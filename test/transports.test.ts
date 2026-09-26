import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SMTPServer } from 'smtp-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifySmtpError, createMailer, resend, smtp } from '../src/index.js'

interface Captured {
  from: string
  to: string[]
  raw: string
}

describe('transporte SMTP (contra un servidor SMTP local)', () => {
  const received: Captured[] = []
  let server: SMTPServer
  let port: number

  beforeAll(async () => {
    server = new SMTPServer({
      disabledCommands: ['STARTTLS'],
      allowInsecureAuth: true,
      onAuth(auth, _s, cb) {
        if (auth.username === 'user' && auth.password === 'pass') return cb(null, { user: 'user' })
        cb(new Error('Invalid credentials'))
      },
      onRcptTo(address, _s, cb) {
        // 550: buzón inexistente (permanente). 451: fallo temporal.
        if (address.address === 'nobody@x.com') return cb(Object.assign(new Error('No such user'), { responseCode: 550 }))
        if (address.address === 'later@x.com') return cb(Object.assign(new Error('Try later'), { responseCode: 451 }))
        cb()
      },
      onData(stream, session, cb) {
        let raw = ''
        stream.on('data', (c: Buffer) => (raw += c.toString()))
        stream.on('end', () => {
          received.push({
            from: (session.envelope.mailFrom as { address: string }).address,
            to: session.envelope.rcptTo.map((r) => r.address),
            raw,
          })
          cb()
        })
      },
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = ((server as unknown as { server: Server }).server.address() as AddressInfo).port
  })

  afterAll(() => new Promise<void>((r) => server.close(r)))

  const transport = (pass = 'pass') =>
    smtp({ host: '127.0.0.1', port, secure: false, auth: { user: 'user', pass }, pool: { maxConnections: 2 }, nodemailer: { ignoreTLS: true } })

  it('envía con remitente, reply-to, cabeceras y adjunto', async () => {
    const mailer = createMailer({ transport: transport(), from: 'Web <web@x.com>' })
    const result = await mailer.send({
      to: ['a@x.com', 'Bea <b@x.com>'],
      replyTo: 'client@y.com',
      subject: 'Asunto ñ',
      text: 'hola',
      html: '<p>hola</p>',
      headers: { 'X-Project': 'rvrox' },
      attachments: [{ filename: 'a.txt', content: Buffer.from('adjunto').toString('base64') }],
    })
    await mailer.close()
    expect(result.accepted).toEqual(['a@x.com', 'b@x.com'])
    const mail = received.at(-1)!
    expect(mail.from).toBe('web@x.com')
    expect(mail.to).toEqual(['a@x.com', 'b@x.com'])
    expect(mail.raw).toMatch(/Reply-To: client@y\.com/)
    expect(mail.raw).toMatch(/X-Project: rvrox/)
    expect(mail.raw).toMatch(/filename=a\.txt/)
  })

  it('usa el pool para muchos envíos', async () => {
    const mailer = createMailer({ transport: transport(), from: 'web@x.com' })
    const before = received.length
    const results = await mailer.sendMany(
      Array.from({ length: 20 }, (_, i) => ({ to: `u${i}@x.com`, subject: `n${i}`, text: 't' })),
      { concurrency: 4 },
    )
    await mailer.close()
    expect(results.every((r) => r.ok)).toBe(true)
    expect(received.length - before).toBe(20)
  })

  it('clasifica errores: 5xx y auth permanentes, 4xx temporales', async () => {
    const mailer = createMailer({ transport: transport(), from: 'web@x.com', retry: { attempts: 1 } })
    await expect(mailer.send({ to: 'nobody@x.com', subject: 's', text: 't' })).rejects.toMatchObject({ retryable: false, providerCode: 550 })
    await expect(mailer.send({ to: 'later@x.com', subject: 's', text: 't' })).rejects.toMatchObject({ retryable: true, providerCode: 451 })
    await mailer.close()

    const bad = createMailer({ transport: transport('wrong'), from: 'web@x.com', retry: { attempts: 1 } })
    await expect(bad.verify()).rejects.toMatchObject({ retryable: false })
    await bad.close()

    expect(classifySmtpError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).retryable).toBe(true)
  })
})

describe('transporte Resend (contra un mock HTTP)', () => {
  let server: Server
  let baseUrl: string
  const requests: Array<{ headers: Record<string, unknown>; body: Record<string, unknown> }> = []
  let nextStatus = 200

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c: Buffer) => (raw += c))
      req.on('end', () => {
        requests.push({ headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> })
        res.writeHead(nextStatus, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(nextStatus === 200 ? { id: 'rs_123' } : { message: 'nope' }))
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  it('traduce el mensaje a la API y pasa la idempotencia', async () => {
    const mailer = createMailer({ transport: resend({ apiKey: 'k', baseUrl }), from: 'Web <web@x.com>' })
    const result = await mailer.send({
      to: 'a@x.com',
      replyTo: 'c@y.com',
      subject: 's',
      html: '<p>h</p>',
      tags: { campaign: 'sept' },
      idempotencyKey: 'abc',
    })
    expect(result).toMatchObject({ messageId: 'rs_123', transport: 'resend' })
    const { headers, body } = requests.at(-1)!
    expect(headers.authorization).toBe('Bearer k')
    expect(headers['idempotency-key']).toBe('abc')
    expect(body).toMatchObject({ from: '"Web" <web@x.com>', to: ['a@x.com'], reply_to: 'c@y.com', tags: [{ name: 'campaign', value: 'sept' }] })
  })

  it('429 y 5xx son temporales; 4xx no', async () => {
    const mailer = createMailer({ transport: resend({ apiKey: 'k', baseUrl }), from: 'web@x.com', retry: { attempts: 1 } })
    nextStatus = 429
    await expect(mailer.send({ to: 'a@x.com', subject: 's', text: 't' })).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true })
    nextStatus = 422
    await expect(mailer.send({ to: 'a@x.com', subject: 's', text: 't' })).rejects.toMatchObject({ retryable: false, providerCode: 422 })
    nextStatus = 200
  })
})
