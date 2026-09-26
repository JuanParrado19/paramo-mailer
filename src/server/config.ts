import { MailerError } from '../errors.js'
import type { MemoryQueueOptions } from '../queue/memory.js'
import type { RedisConnection } from '../queue/redis.js'
import type { QueueOptions, WorkerOptions } from '../queue/types.js'
import { memory, type MemoryOptions } from '../transports/memory.js'
import { resend, type ResendOptions } from '../transports/resend.js'
import { smtp, type SmtpOptions } from '../transports/smtp.js'
import type { AddressInput, RetryOptions, Template, Transport } from '../types.js'

export type TransportConfig =
  | ({ type: 'smtp' } & Omit<SmtpOptions, 'name'>)
  | ({ type: 'resend' } & Omit<ResendOptions, 'name'>)
  | ({ type: 'memory' } & Omit<MemoryOptions, 'name'>)

export interface RateLimit {
  max: number
  windowMs: number
}

export interface ApiKeyConfig {
  /** Identificador legible (aparece en logs y prefija los ids de trabajo). */
  id: string
  /** La clave en claro, normalmente desde process.env. */
  key?: string
  /** O su SHA-256 en hex, para no guardar la clave en el servidor. */
  keyHash?: string
  /**
   * Remitentes permitidos: direcciones exactas o dominios (`@midominio.com`).
   * Sin esto la clave puede enviar como cualquier remitente.
   */
  allowedFrom?: string[]
  /** Fuerza estos transportes para la clave (ignora lo que pida el cliente). */
  transport?: string | string[]
  /** Solicitudes por ventana. */
  rateLimit?: RateLimit
}

export interface FieldConfig {
  type?: 'text' | 'email' | 'tel' | 'textarea' | 'select' | 'url' | 'number'
  label?: string
  required?: boolean
  /** Por defecto 200, o 5000 en textarea. */
  maxLength?: number
  /** Valores válidos para `select`. */
  options?: string[]
}

export interface FormConfig {
  /** Quién recibe los envíos del formulario. */
  to: AddressInput | AddressInput[]
  from?: AddressInput
  transport?: string | string[]
  /** Asunto con {{campos}}: `"New inquiry from {{name}}"`. */
  subject: string
  fields: Record<string, FieldConfig>
  /**
   * Orígenes que pueden enviar (`https://midominio.com`). Recomendado: un
   * formulario público sin esto acepta envíos desde cualquier web.
   */
  allowedOrigins?: string[]
  /** Campo trampa: si llega relleno, se responde OK sin enviar. */
  honeypot?: string
  /** Por IP. Por defecto 5 por hora. */
  rateLimit?: RateLimit
  /** Campo cuyo valor va en Reply-To. Por defecto el primer campo `email`. */
  replyToField?: string | false
  /** Plantilla registrada o en línea; por defecto una tabla con los campos. */
  template?: string | Template
  /** Para `<form>` HTML sin JavaScript: a dónde redirigir tras enviar. */
  redirect?: { success: string; error?: string }
}

export type QueueConfig =
  | ({ driver: 'memory' } & QueueOptions & WorkerOptions & Pick<MemoryQueueOptions, 'keepFinished'>)
  | ({
      driver: 'redis'
      connection: RedisConnection
      name?: string
      prefix?: string
    } & QueueOptions &
      WorkerOptions)

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export interface ServerConfig {
  port?: number
  /** Por defecto 127.0.0.1: pensado para ir detrás de nginx. */
  host?: string
  /**
   * Confiar en X-Real-IP / X-Forwarded-For para la IP del cliente. Solo si
   * hay un proxy delante; si no, cualquiera podría falsearla.
   */
  trustProxy?: boolean
  transports: Record<string, TransportConfig | Transport>
  defaultTransport?: string | string[]
  from?: AddressInput
  templates?: Record<string, Template>
  globals?: Record<string, unknown>
  retry?: RetryOptions
  /** Por defecto cola en memoria. */
  queue?: QueueConfig
  apiKeys?: ApiKeyConfig[]
  forms?: Record<string, FormConfig>
  /** Máximo de mensajes por llamada a /v1/batch. Por defecto 1000. */
  maxBatchSize?: number
  /** Máximo de destinatarios (to+cc+bcc) por mensaje. Por defecto 50. */
  maxRecipients?: number
  /** Tamaño máximo del cuerpo HTTP. Por defecto 10 MB (adjuntos en base64). */
  maxBodyBytes?: number
  logger?: Logger
}

/** Solo da tipos al archivo de configuración. */
export const defineConfig = (config: ServerConfig): ServerConfig => config

export function buildTransports(config: ServerConfig): Transport[] {
  const entries = Object.entries(config.transports ?? {})
  if (entries.length === 0) throw new MailerError('CONFIG_ERROR', 'Configura al menos un transporte')
  return entries.map(([name, t]) => {
    if ('send' in t && typeof t.send === 'function') {
      if (t.name !== name) throw new MailerError('CONFIG_ERROR', `El transporte "${name}" se llama "${t.name}"`)
      return t
    }
    const { type, ...options } = t as TransportConfig
    switch (type) {
      case 'smtp':
        return smtp({ ...(options as SmtpOptions), name })
      case 'resend':
        return resend({ ...(options as ResendOptions), name })
      case 'memory':
        return memory({ ...(options as MemoryOptions), name })
      default:
        throw new MailerError('CONFIG_ERROR', `Tipo de transporte desconocido en "${name}": ${String(type)}`)
    }
  })
}

/** Logger de una línea JSON por evento: fácil de leer en pm2 o Docker. */
export const jsonLogger: Logger = {
  info: (message, meta) => console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), message, ...meta })),
  warn: (message, meta) => console.warn(JSON.stringify({ level: 'warn', time: new Date().toISOString(), message, ...meta })),
  error: (message, meta) => console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), message, ...meta })),
}
