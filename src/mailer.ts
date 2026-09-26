import { assertHeaderSafe, parseAddress, parseAddressList } from './address.js'
import { MailerError } from './errors.js'
import { withRetry } from './retry.js'
import { TemplateRegistry } from './template.js'
import type {
  AddressInput,
  Message,
  MessageInput,
  RetryOptions,
  SendResult,
  Template,
  Transport,
} from './types.js'

export interface MailerOptions {
  /**
   * Un transporte o varios. Sin `defaultTransport`, todos forman una cadena
   * de failover en este orden.
   */
  transport: Transport | Transport[]
  /** Nombre(s) de los transportes a usar cuando el mensaje no elige. */
  defaultTransport?: string | string[]
  /** Remitente por defecto cuando el mensaje no trae `from`. */
  from?: AddressInput
  /** Reply-To por defecto. */
  replyTo?: AddressInput
  templates?: Record<string, Template>
  /** Variables disponibles en todas las plantillas (marca, URLs…). */
  globals?: Record<string, unknown>
  /** Cabeceras añadidas a todos los mensajes. */
  headers?: Record<string, string>
  retry?: RetryOptions
  /** Se llama tras cada envío, bien o mal. Útil para logs y métricas. */
  onSend?: (event: SendEvent) => void
}

export type SendEvent =
  | { ok: true; message: Message; result: SendResult; durationMs: number }
  | { ok: false; message: Message | undefined; error: unknown; durationMs: number }

export type SettledResult =
  | { ok: true; result: SendResult }
  | { ok: false; error: MailerError | Error }

export interface Mailer {
  send(input: MessageInput): Promise<SendResult>
  /**
   * Envía muchos mensajes con concurrencia limitada y nunca lanza: devuelve
   * un resultado por mensaje, en el mismo orden. Para volúmenes grandes o
   * que deban sobrevivir a un reinicio, usa una cola (`/queue`).
   */
  sendMany(inputs: MessageInput[], options?: { concurrency?: number }): Promise<SettledResult[]>
  /** Aplica defaults y plantilla sin enviar: vista previa o tests. */
  build(input: MessageInput): Promise<Message>
  templates: TemplateRegistry
  /** Nombres de los transportes registrados. */
  transportNames: string[]
  verify(): Promise<void>
  close(): Promise<void>
}

export function createMailer(options: MailerOptions): Mailer {
  const transports = Array.isArray(options.transport) ? options.transport : [options.transport]
  if (transports.length === 0) throw new MailerError('CONFIG_ERROR', 'Hace falta al menos un transporte')

  const byName = new Map(transports.map((t) => [t.name, t]))
  if (byName.size !== transports.length) {
    throw new MailerError('CONFIG_ERROR', 'Hay transportes con el mismo nombre')
  }
  const resolveChain = (names: string | string[] | undefined): Transport[] => {
    if (names === undefined) return transports
    return (Array.isArray(names) ? names : [names]).map((n) => {
      const t = byName.get(n)
      if (!t) throw new MailerError('CONFIG_ERROR', `No existe el transporte "${n}"`)
      return t
    })
  }
  const defaultChain = resolveChain(options.defaultTransport)

  const templates = new TemplateRegistry(options.templates)
  const defaultFrom = options.from === undefined ? undefined : parseAddress(options.from)
  const defaultReplyTo = options.replyTo === undefined ? undefined : parseAddress(options.replyTo)

  async function build(input: MessageInput): Promise<Message> {
    if (!input || typeof input !== 'object') {
      throw new MailerError('INVALID_MESSAGE', 'El mensaje debe ser un objeto')
    }

    let { subject, html, text } = input
    if (input.template) {
      const rendered = await templates.render(input.template, { ...options.globals, ...input.data })
      // Lo explícito en el mensaje gana sobre la plantilla.
      subject ??= rendered.subject
      html ??= rendered.html
      text ??= rendered.text
    }

    const from = input.from === undefined ? defaultFrom : parseAddress(input.from)
    if (!from) throw new MailerError('INVALID_MESSAGE', 'Falta el remitente (from)')

    const to = parseAddressList(input.to)
    const cc = parseAddressList(input.cc)
    const bcc = parseAddressList(input.bcc)
    if (to.length + cc.length + bcc.length === 0) {
      throw new MailerError('INVALID_MESSAGE', 'El mensaje no tiene destinatarios')
    }
    if (!subject) throw new MailerError('INVALID_MESSAGE', 'Falta el asunto')
    if (!html && !text) throw new MailerError('INVALID_MESSAGE', 'Falta el cuerpo (html o text)')
    assertHeaderSafe('El asunto', subject)

    const headers = { ...options.headers, ...input.headers }
    for (const [key, value] of Object.entries(headers)) {
      assertHeaderSafe(`La cabecera ${key}`, key)
      assertHeaderSafe(`La cabecera ${key}`, value)
    }

    const replyTo = input.replyTo === undefined ? defaultReplyTo : parseAddress(input.replyTo)

    return {
      from,
      to,
      cc,
      bcc,
      ...(replyTo && { replyTo }),
      subject,
      ...(text !== undefined && { text }),
      ...(html !== undefined && { html }),
      headers,
      attachments: input.attachments ?? [],
      tags: input.tags ?? {},
      ...(input.idempotencyKey && { idempotencyKey: input.idempotencyKey }),
    }
  }

  // Cada transporte recibe sus propios reintentos; si los agota con un
  // error reintentable se pasa al siguiente. Un error permanente (dirección
  // rechazada, credenciales) corta: otro proveedor no lo arreglaría.
  async function deliver(message: Message, chain: Transport[]): Promise<SendResult> {
    let lastError: unknown
    for (const transport of chain) {
      try {
        return await withRetry(() => transport.send(message), options.retry)
      } catch (err) {
        lastError = err
        if (err instanceof MailerError && !err.retryable) throw err
      }
    }
    throw lastError
  }

  async function send(input: MessageInput): Promise<SendResult> {
    const started = Date.now()
    let message: Message | undefined
    try {
      const chain = input.transport === undefined ? defaultChain : resolveChain(input.transport)
      message = await build(input)
      const result = await deliver(message, chain)
      options.onSend?.({ ok: true, message, result, durationMs: Date.now() - started })
      return result
    } catch (error) {
      options.onSend?.({ ok: false, message, error, durationMs: Date.now() - started })
      throw error
    }
  }

  async function sendMany(
    inputs: MessageInput[],
    { concurrency = 5 }: { concurrency?: number } = {},
  ): Promise<SettledResult[]> {
    const results: SettledResult[] = new Array(inputs.length)
    let next = 0
    const worker = async () => {
      while (next < inputs.length) {
        const i = next++
        try {
          results[i] = { ok: true, result: await send(inputs[i]!) }
        } catch (error) {
          results[i] = { ok: false, error: error as Error }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, worker))
    return results
  }

  return {
    send,
    sendMany,
    build,
    templates,
    transportNames: [...byName.keys()],
    async verify() {
      await Promise.all(transports.map((t) => t.verify?.()))
    },
    async close() {
      await Promise.all(transports.map((t) => t.close?.()))
    },
  }
}
