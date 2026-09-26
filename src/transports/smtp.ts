import nodemailer from 'nodemailer'
import { formatAddress } from '../address.js'
import { MailerError } from '../errors.js'
import type { Message, SendResult, Transport } from '../types.js'

export interface SmtpOptions {
  /** Nombre con el que aparece en logs y en `SendResult.transport`. */
  name?: string
  host: string
  /** 465 = TLS directo (por defecto); 587 = STARTTLS. */
  port?: number
  secure?: boolean
  auth?: { user: string; pass: string }
  /**
   * Conexiones reutilizables. Imprescindible para volumen: abrir una
   * conexión TLS por correo es lo que más limita el throughput.
   */
  pool?:
    | boolean
    | {
        maxConnections?: number
        /** Correos por conexión antes de reabrirla. */
        maxMessages?: number
        /** Máximo de correos por `rateDeltaMs` (límite del proveedor). */
        rateLimit?: number
        rateDeltaMs?: number
      }
  /** Timeouts en ms. */
  connectionTimeoutMs?: number
  socketTimeoutMs?: number
  /** Opciones extra que se pasan tal cual a nodemailer. */
  nodemailer?: Record<string, unknown>
}

// Errores de red o del servidor que suelen resolverse solos.
const RETRYABLE_CODES = new Set([
  'ECONNECTION',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
])

interface NodemailerError extends Error {
  code?: string
  responseCode?: number
}

/** 4xx SMTP = temporal (reintentar); 5xx = permanente. Autenticación nunca. */
export function classifySmtpError(err: unknown): MailerError {
  const e = err as NodemailerError
  const responseCode = e?.responseCode
  const retryable =
    e?.code === 'EAUTH'
      ? false
      : responseCode !== undefined
        ? responseCode >= 400 && responseCode < 500
        : RETRYABLE_CODES.has(e?.code ?? '')
  return new MailerError('TRANSPORT_ERROR', e?.message ?? 'Error SMTP', {
    retryable,
    providerCode: responseCode ?? e?.code,
    cause: err,
  })
}

export function smtp(options: SmtpOptions): Transport {
  const port = options.port ?? 465
  const pool = options.pool === true ? {} : options.pool || undefined
  const name = options.name ?? `smtp:${options.host}`

  const transporter = nodemailer.createTransport({
    host: options.host,
    port,
    secure: options.secure ?? port === 465,
    ...(options.auth && { auth: options.auth }),
    ...(pool && {
      pool: true,
      maxConnections: pool.maxConnections ?? 3,
      maxMessages: pool.maxMessages ?? 100,
      ...(pool.rateLimit && { rateLimit: pool.rateLimit, rateDelta: pool.rateDeltaMs ?? 1000 }),
    }),
    connectionTimeout: options.connectionTimeoutMs ?? 15_000,
    socketTimeout: options.socketTimeoutMs ?? 30_000,
    ...options.nodemailer,
  })

  return {
    name,
    async send(message: Message): Promise<SendResult> {
      try {
        const info = await transporter.sendMail({
          from: formatAddress(message.from),
          to: message.to.map(formatAddress),
          cc: message.cc.map(formatAddress),
          bcc: message.bcc.map(formatAddress),
          ...(message.replyTo && { replyTo: formatAddress(message.replyTo) }),
          subject: message.subject,
          text: message.text,
          html: message.html,
          headers: message.headers,
          attachments: message.attachments.map((a) => ({
            filename: a.filename,
            ...(a.content !== undefined && { content: a.content, encoding: 'base64' }),
            ...(a.path !== undefined && { path: a.path }),
            ...(a.contentType && { contentType: a.contentType }),
            ...(a.cid && { cid: a.cid }),
          })),
        })
        const toText = (list: unknown[] | undefined) =>
          (list ?? []).map((x) => (typeof x === 'string' ? x : (x as { address: string }).address))
        return {
          messageId: info.messageId,
          transport: name,
          accepted: toText(info.accepted),
          rejected: toText(info.rejected),
        }
      } catch (err) {
        throw classifySmtpError(err)
      }
    },
    async verify() {
      try {
        await transporter.verify()
      } catch (err) {
        throw classifySmtpError(err)
      }
    },
    async close() {
      transporter.close()
    },
  }
}
