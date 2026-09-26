export { createMailer } from './mailer.js'
export type { Mailer, MailerOptions, SendEvent, SettledResult } from './mailer.js'

export { smtp, classifySmtpError } from './transports/smtp.js'
export type { SmtpOptions } from './transports/smtp.js'
export { resend } from './transports/resend.js'
export type { ResendOptions } from './transports/resend.js'
export { memory } from './transports/memory.js'
export type { MemoryOptions, MemoryTransport } from './transports/memory.js'

export { TemplateRegistry, escapeHtml, interpolate, renderTemplate } from './template.js'
export { parseAddress, parseAddressList, formatAddress, isValidEmail } from './address.js'
export { MailerError, isRetryable } from './errors.js'
export type { MailerErrorCode } from './errors.js'
export { withRetry } from './retry.js'

export type {
  Address,
  AddressInput,
  Attachment,
  Message,
  MessageInput,
  RetryOptions,
  SendResult,
  Template,
  TemplateOutput,
  Transport,
} from './types.js'
