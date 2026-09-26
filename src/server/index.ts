import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { MailerError } from '../errors.js'
import { createMailer, type Mailer } from '../mailer.js'
import { createMemoryQueue } from '../queue/memory.js'
import { createRedisQueue, createRedisWorker, type RedisWorker } from '../queue/redis.js'
import type { AddOptions, MailQueue } from '../queue/types.js'
import type { MessageInput } from '../types.js'
import { ApiKeys, isFromAllowed } from './auth.js'
import { buildTransports, jsonLogger, type ApiKeyConfig, type ServerConfig } from './config.js'
import { buildFormMessage, isOriginAllowed, validateFields } from './forms.js'
import { HttpError, clientIp, readPayload, redirect, sendJson } from './http.js'
import { RateLimiter } from './rate-limit.js'

export * from './config.js'
export { hashKey } from './auth.js'

/**
 * api: recibe HTTP y encola. worker: solo envía (Redis). all: ambas cosas.
 * Con la cola en memoria el rol es siempre "all".
 */
export type Role = 'api' | 'worker' | 'all'

export interface MailServer {
  mailer: Mailer
  queue?: MailQueue
  /** El servidor HTTP (no existe en rol worker). */
  http?: Server
  listen(): Promise<AddressInfo | undefined>
  /** Cierre ordenado: deja de aceptar y termina lo que está en curso. */
  close(): Promise<void>
}

const DEFAULT_FORM_LIMIT = { max: 5, windowMs: 60 * 60 * 1000 }

// Los ids de trabajo solo llevan caracteres que acepta BullMQ; si la clave
// del cliente trae otros se usa su hash, conservando el prefijo de la API key.
const safeKey = (key: string): string =>
  /^[\w.\-@]{1,150}$/.test(key) ? key : createHash('sha256').update(key).digest('hex')

export async function createMailServer(config: ServerConfig, { role = 'all' }: { role?: Role } = {}): Promise<MailServer> {
  const log = config.logger ?? jsonLogger
  const queueConfig = config.queue ?? { driver: 'memory' as const }
  if (queueConfig.driver === 'memory') role = 'all'

  const mailer = createMailer({
    transport: buildTransports(config),
    ...(config.defaultTransport && { defaultTransport: config.defaultTransport }),
    ...(config.from && { from: config.from }),
    ...(config.templates && { templates: config.templates }),
    ...(config.globals && { globals: config.globals }),
    // La cola ya reintenta con backoff largo: dentro del envío basta un
    // reintento rápido para tropiezos de red.
    retry: config.retry ?? { attempts: 2, minDelayMs: 300 },
    onSend: (e) => {
      if (e.ok) {
        log.info('mail.sent', { transport: e.result.transport, recipients: e.result.accepted.length, ms: e.durationMs, tags: e.message.tags })
      } else {
        const err = e.error as Partial<MailerError>
        log.warn('mail.error', { code: err.code, providerCode: err.providerCode, retryable: err.retryable, message: err.message, tags: e.message?.tags })
      }
    },
  })

  // Comprueba credenciales al arrancar sin bloquear: un fallo sale en los
  // logs enseguida, no cuando alguien intenta enviar.
  if (role !== 'api') {
    mailer.verify().then(
      () => log.info('transports.verified', { transports: mailer.transportNames }),
      (err: Error) => log.error('transports.unverified', { message: err.message }),
    )
  }

  let queue: MailQueue | undefined
  let worker: RedisWorker | undefined
  const logFailed = (job: { id: string; attempts: number; error?: unknown }) =>
    log.error('job.failed', { id: job.id, attempts: job.attempts, error: job.error })

  if (queueConfig.driver === 'memory') {
    queue = createMemoryQueue({ ...queueConfig, mailer }).on('failed', logFailed)
  } else {
    if (role !== 'worker') queue = await createRedisQueue(queueConfig)
    if (role !== 'api') worker = (await createRedisWorker({ ...queueConfig, mailer })).on('failed', logFailed)
  }

  if (role === 'worker') {
    return {
      mailer,
      async listen() {
        log.info('worker.started', { transports: mailer.transportNames })
        return undefined
      },
      async close() {
        await worker?.close()
        await mailer.close()
      },
    }
  }

  const keys = new ApiKeys(config.apiKeys)
  const forms = config.forms ?? {}
  const limiter = new RateLimiter()
  const trustProxy = config.trustProxy ?? false
  const maxBody = config.maxBodyBytes ?? 10 * 1024 * 1024
  const maxBatch = config.maxBatchSize ?? 1000
  const maxRecipients = config.maxRecipients ?? 50

  for (const [id, form] of Object.entries(forms)) {
    if (!/^[\w-]+$/.test(id)) throw new MailerError('CONFIG_ERROR', `Id de formulario inválido: "${id}"`)
    if (!form.allowedOrigins) log.warn('form.open', { form: id, hint: 'Define allowedOrigins para aceptar solo tu web' })
  }

  // --- Mensajes de la API --------------------------------------------------

  const count = (v: unknown) => (v === undefined ? 0 : Array.isArray(v) ? v.length : 1)

  /**
   * Valida y aplica las reglas de la clave. Separa del mensaje los campos de
   * control (sendAt, priority) y devuelve lo que se encola.
   */
  async function prepare(key: ApiKeyConfig, body: Record<string, unknown>): Promise<{ message: MessageInput; options: AddOptions }> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Each message must be an object')
    const { sendAt, priority, ...input } = body as unknown as MessageInput & { sendAt?: unknown; priority?: unknown }

    if (count(input.to) + count(input.cc) + count(input.bcc) > maxRecipients) {
      throw new HttpError(400, `Too many recipients (max ${maxRecipients}); use /v1/batch`)
    }
    // Prefijo por clave: dos proyectos no chocan con la misma clave de
    // idempotencia, y /v1/jobs solo muestra los trabajos propios.
    const jobId = `${key.id}.${input.idempotencyKey ? safeKey(String(input.idempotencyKey)) : randomUUID()}`
    const message: MessageInput = {
      ...input,
      ...(key.transport && { transport: key.transport }),
      ...(input.idempotencyKey && { idempotencyKey: jobId }),
    }

    // build() valida direcciones, plantilla, cabeceras y remitente sin
    // enviar: el error se devuelve ahora como 400 y no más tarde en la cola.
    let from: string
    try {
      if (message.transport !== undefined) {
        const names = Array.isArray(message.transport) ? message.transport : [message.transport]
        const unknown = names.find((n) => !mailer.transportNames.includes(n))
        if (unknown) throw new MailerError('INVALID_MESSAGE', `Unknown transport "${unknown}"`)
      }
      from = (await mailer.build(message)).from.address
    } catch (err) {
      if (err instanceof MailerError) throw new HttpError(400, err.message, { code: err.code })
      throw err
    }
    if (!isFromAllowed(from, key.allowedFrom)) throw new HttpError(403, `This key cannot send as ${from}`)

    const options: AddOptions = { id: jobId }
    if (sendAt !== undefined) {
      const at = typeof sendAt === 'string' ? Date.parse(sendAt) : NaN
      if (Number.isNaN(at)) throw new HttpError(400, 'sendAt must be an ISO date')
      if (at > Date.now()) options.delayMs = at - Date.now()
    }
    if (typeof priority === 'number') options.priority = priority
    return { message, options }
  }

  // --- Rutas ---------------------------------------------------------------

  function requireKey(req: IncomingMessage): ApiKeyConfig {
    const key = keys.authenticate(req)
    if (!key) throw new HttpError(401, 'Missing or invalid API key')
    if (key.rateLimit && !limiter.take(`key:${key.id}`, key.rateLimit)) throw new HttpError(429, 'Rate limit exceeded')
    return key
  }

  async function handleSend(req: IncomingMessage, res: ServerResponse) {
    const key = requireKey(req)
    const { data } = await readPayload(req, maxBody)
    const { message, options } = await prepare(key, data)
    const { id } = await queue!.add(message, options)
    sendJson(res, 202, { id })
  }

  /**
   * Dos formas:
   *   { messages: [MessageInput, …] }
   *   { template, subject?, from?, data?, recipients: [{ to, data?, idempotencyKey? }, …] }
   * La segunda es la de campañas: una plantilla y datos por destinatario.
   * Los mensajes inválidos se informan y el resto se encola igual.
   */
  async function handleBatch(req: IncomingMessage, res: ServerResponse) {
    const key = requireKey(req)
    const { data } = await readPayload(req, maxBody)
    let items: Record<string, unknown>[]
    if (Array.isArray(data.messages)) {
      items = data.messages as Record<string, unknown>[]
    } else if (Array.isArray(data.recipients)) {
      const { recipients, data: shared, ...base } = data as {
        recipients: Record<string, unknown>[]
        data?: Record<string, unknown>
      }
      items = recipients.map((r) => ({
        ...base,
        ...r,
        data: { ...shared, ...(r?.data as Record<string, unknown> | undefined) },
      }))
    } else {
      throw new HttpError(400, 'Send "messages" or "recipients"')
    }
    if (items.length === 0) throw new HttpError(400, 'The batch is empty')
    if (items.length > maxBatch) throw new HttpError(400, `Too many messages (max ${maxBatch} per batch)`)

    const accepted: Array<{ index: number; message: MessageInput; options: AddOptions }> = []
    const errors: Array<{ index: number; error: string }> = []
    for (const [index, item] of items.entries()) {
      try {
        accepted.push({ index, ...(await prepare(key, item)) })
      } catch (err) {
        if (!(err instanceof HttpError)) throw err
        errors.push({ index, error: err.message })
      }
    }
    const ids = accepted.length ? await queue!.addBulk(accepted) : []
    sendJson(res, accepted.length ? 202 : 400, {
      queued: ids.map((r, i) => ({ index: accepted[i]!.index, id: r.id })),
      errors,
    })
  }

  async function handleJob(req: IncomingMessage, res: ServerResponse, id: string) {
    const key = requireKey(req)
    const job = id.startsWith(`${key.id}.`) ? await queue!.getJob(id) : undefined
    if (!job) throw new HttpError(404, 'Job not found')
    sendJson(res, 200, job)
  }

  function corsHeaders(req: IncomingMessage, allowed: string[] | undefined): Record<string, string> {
    const origin = req.headers.origin
    if (!origin || !isOriginAllowed(origin, allowed)) return {}
    return {
      'Access-Control-Allow-Origin': !allowed || allowed.includes('*') ? '*' : origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    }
  }

  async function handleForm(req: IncomingMessage, res: ServerResponse, formId: string) {
    const form = forms[formId]
    if (!form) throw new HttpError(404, 'Form not found')
    const cors = corsHeaders(req, form.allowedOrigins)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      return res.end()
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed')

    const { data, isForm } = await readPayload(req, 64 * 1024)
    // Formulario HTML clásico con `redirect`: se contesta con 303, no JSON.
    const respond = (status: number, payload: Record<string, unknown>) => {
      if (isForm && form.redirect) {
        return redirect(res, status < 400 ? form.redirect.success : (form.redirect.error ?? form.redirect.success))
      }
      sendJson(res, status, payload, cors)
    }

    try {
      if (!isOriginAllowed(req.headers.origin, form.allowedOrigins)) throw new HttpError(403, 'Origin not allowed')

      const ip = clientIp(req, trustProxy)
      if (form.honeypot && data[form.honeypot]) {
        log.info('form.honeypot', { form: formId, ip })
        // Se finge éxito para no dar pistas al bot.
        return respond(200, { ok: true })
      }

      const values = validateFields(form, data)
      if (!limiter.take(`form:${formId}:${ip}`, form.rateLimit ?? DEFAULT_FORM_LIMIT)) {
        throw new HttpError(429, 'Too many submissions. Please try again later.')
      }

      const message = await buildFormMessage(formId, form, values)
      await mailer.build(message)
      const { id } = await queue!.add(message)
      log.info('form.queued', { form: formId, id, ip })
      respond(200, { ok: true })
    } catch (err) {
      if (err instanceof HttpError) return respond(err.status, { error: err.message, ...(err.details as object | undefined) })
      // Una dirección que pasa la validación del formulario pero no la del
      // correo es un error del visitante, no del servidor.
      if (err instanceof MailerError && err.code === 'INVALID_ADDRESS') {
        return respond(400, { error: 'Please check your email address.' })
      }
      throw err
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://local').pathname.replace(/\/+$/, '') || '/'

    if (path === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, role, transports: mailer.transportNames, queue: await queue!.counts() })
    }
    if (path === '/v1/send' && req.method === 'POST') return handleSend(req, res)
    if (path === '/v1/batch' && req.method === 'POST') return handleBatch(req, res)

    const job = /^\/v1\/jobs\/([^/]+)$/.exec(path)
    if (job && req.method === 'GET') return handleJob(req, res, decodeURIComponent(job[1]!))

    const form = /^\/v1\/forms\/([\w-]+)$/.exec(path)
    if (form) return handleForm(req, res, form[1]!)

    throw new HttpError(404, 'Not found')
  }

  const http = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.destroy()
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, ...(err.details as object | undefined) })
      log.error('http.error', { path: req.url, message: (err as Error).message })
      sendJson(res, 500, { error: 'Internal error' })
    })
  })
  // Corta clientes que abren conexión y no terminan de enviar (slowloris).
  http.requestTimeout = 30_000
  http.headersTimeout = 15_000

  return {
    mailer,
    queue,
    http,
    listen() {
      return new Promise((resolve, reject) => {
        http.once('error', reject)
        http.listen(config.port ?? 8080, config.host ?? '127.0.0.1', () => {
          const address = http.address() as AddressInfo
          log.info('server.started', {
            role,
            port: address.port,
            transports: mailer.transportNames,
            forms: Object.keys(forms),
            apiKeys: keys.size,
          })
          resolve(address)
        })
      })
    },
    async close() {
      await new Promise<void>((resolve) => http.close(() => resolve()))
      limiter.stop()
      await queue?.close()
      await worker?.close()
      await mailer.close()
    },
  }
}
