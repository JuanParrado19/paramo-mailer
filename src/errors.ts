export type MailerErrorCode =
  | 'INVALID_MESSAGE'
  | 'INVALID_ADDRESS'
  | 'TEMPLATE_NOT_FOUND'
  | 'TRANSPORT_ERROR'
  | 'RATE_LIMITED'
  | 'CONFIG_ERROR'

/**
 * Error con código estable y marca de reintentable. Los reintentos, el
 * failover y las colas deciden con `retryable`, no leyendo mensajes.
 */
export class MailerError extends Error {
  readonly code: MailerErrorCode
  readonly retryable: boolean
  /** Código del proveedor (respuesta SMTP, status HTTP…), si lo hay. */
  readonly providerCode?: string | number

  constructor(
    code: MailerErrorCode,
    message: string,
    options: { retryable?: boolean; providerCode?: string | number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'MailerError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.providerCode = options.providerCode
  }
}

export const isRetryable = (err: unknown): boolean =>
  err instanceof MailerError ? err.retryable : true
