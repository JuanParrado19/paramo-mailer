import { formatAddress } from '../address.js'
import { MailerError } from '../errors.js'
import type { Message, SendResult, Transport } from '../types.js'

export interface ResendOptions {
  apiKey: string
  name?: string
  /** Para tests o un proxy. */
  baseUrl?: string
  timeoutMs?: number
}

/**
 * Resend (resend.com) por su API HTTP, sin SDK. Pensado para volumen: no
 * tiene los límites diarios de un buzón SMTP de hosting compartido.
 */
export function resend(options: ResendOptions): Transport {
  const name = options.name ?? 'resend'
  const baseUrl = options.baseUrl ?? 'https://api.resend.com'

  return {
    name,
    async send(message: Message): Promise<SendResult> {
      const recipients = [...message.to, ...message.cc, ...message.bcc].map((a) => a.address)
      let res: Response
      try {
        res = await fetch(`${baseUrl}/emails`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
            ...(message.idempotencyKey && { 'Idempotency-Key': message.idempotencyKey }),
          },
          body: JSON.stringify({
            from: formatAddress(message.from),
            to: message.to.map(formatAddress),
            ...(message.cc.length && { cc: message.cc.map(formatAddress) }),
            ...(message.bcc.length && { bcc: message.bcc.map(formatAddress) }),
            ...(message.replyTo && { reply_to: formatAddress(message.replyTo) }),
            subject: message.subject,
            ...(message.html !== undefined && { html: message.html }),
            ...(message.text !== undefined && { text: message.text }),
            ...(Object.keys(message.headers).length && { headers: message.headers }),
            ...(message.attachments.length && {
              attachments: message.attachments.map((a) => ({
                filename: a.filename,
                ...(a.content !== undefined && { content: a.content }),
                ...(a.path !== undefined && { path: a.path }),
                ...(a.contentType && { content_type: a.contentType }),
              })),
            }),
            ...(Object.keys(message.tags).length && {
              tags: Object.entries(message.tags).map(([k, v]) => ({ name: k, value: v })),
            }),
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        })
      } catch (err) {
        // Red caída o timeout: vale la pena reintentar.
        throw new MailerError('TRANSPORT_ERROR', `Resend no respondió: ${(err as Error).message}`, {
          retryable: true,
          cause: err,
        })
      }

      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string }
      if (!res.ok) {
        // 429 y 5xx son temporales; el resto (400, 401, 403, 422) no.
        const retryable = res.status === 429 || res.status >= 500
        throw new MailerError(
          res.status === 429 ? 'RATE_LIMITED' : 'TRANSPORT_ERROR',
          `Resend ${res.status}: ${body.message ?? res.statusText}`,
          { retryable, providerCode: res.status },
        )
      }
      return { messageId: body.id ?? '', transport: name, accepted: recipients, rejected: [] }
    },
  }
}
