/** Dirección como texto (`"Nombre <a@b.com>"` o `"a@b.com"`) u objeto. */
export type AddressInput = string | { name?: string; address: string }

/** Dirección ya validada y separada. */
export interface Address {
  name?: string
  address: string
}

export interface Attachment {
  filename: string
  /** Contenido en base64 (serializable: sirve para colas). */
  content?: string
  /** Ruta local o URL; solo la resuelve el transporte SMTP. */
  path?: string
  contentType?: string
  /** Para imágenes embebidas: `<img src="cid:logo">`. */
  cid?: string
}

/**
 * Lo que recibe `mailer.send()`. Todo es serializable a JSON, así el mismo
 * objeto puede viajar por una cola Redis hasta otro proceso.
 */
export interface MessageInput {
  to: AddressInput | AddressInput[]
  cc?: AddressInput | AddressInput[]
  bcc?: AddressInput | AddressInput[]
  /** Si se omite, se usa el `from` por defecto del mailer. */
  from?: AddressInput
  replyTo?: AddressInput
  subject?: string
  text?: string
  html?: string
  /** Nombre de una plantilla registrada; rellena subject/html/text. */
  template?: string
  /** Variables para la plantilla. */
  data?: Record<string, unknown>
  headers?: Record<string, string>
  attachments?: Attachment[]
  /** Etiquetas libres para métricas o para el proveedor (p. ej. Resend). */
  tags?: Record<string, string>
  /**
   * Transporte(s) a usar, por nombre y en orden de failover. Si se omite,
   * se usa `defaultTransport` del mailer (o todos en orden).
   */
  transport?: string | string[]
  /**
   * Clave para no enviar dos veces el mismo correo. La cola la usa como id
   * del trabajo y los proveedores HTTP que la soportan la reenvían.
   */
  idempotencyKey?: string
}

/** Mensaje listo para un transporte: plantilla aplicada, direcciones validadas. */
export interface Message {
  from: Address
  to: Address[]
  cc: Address[]
  bcc: Address[]
  replyTo?: Address
  subject: string
  text?: string
  html?: string
  headers: Record<string, string>
  attachments: Attachment[]
  tags: Record<string, string>
  idempotencyKey?: string
}

export interface SendResult {
  /** Id que devuelve el proveedor (Message-ID en SMTP). */
  messageId: string
  /** Nombre del transporte que lo envió (útil con failover). */
  transport: string
  accepted: string[]
  rejected: string[]
}

/**
 * Contrato de un transporte. Para añadir un proveedor nuevo (SES, Brevo,
 * Postmark…) basta con implementar `send`.
 */
export interface Transport {
  readonly name: string
  send(message: Message): Promise<SendResult>
  /** Comprueba credenciales/conexión sin enviar nada. */
  verify?(): Promise<void>
  /** Libera conexiones (pool SMTP, etc.). */
  close?(): Promise<void>
}

export interface TemplateOutput {
  subject?: string
  html?: string
  text?: string
}

/**
 * Plantilla: textos con `{{variables}}` o una función, para usar cualquier
 * motor (React Email, Handlebars, MJML…) desde fuera de la librería.
 */
export type Template =
  | TemplateOutput
  | ((data: Record<string, unknown>) => TemplateOutput | Promise<TemplateOutput>)

export interface RetryOptions {
  /** Intentos totales, incluido el primero. Por defecto 3. */
  attempts?: number
  /** Espera inicial en ms; se duplica en cada intento. Por defecto 500. */
  minDelayMs?: number
  /** Tope de espera entre intentos. Por defecto 10 000. */
  maxDelayMs?: number
}
