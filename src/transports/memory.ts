import { randomUUID } from 'node:crypto'
import type { Message, SendResult, Transport } from '../types.js'

export interface MemoryTransport extends Transport {
  /** Mensajes "enviados", en orden. */
  readonly sent: Message[]
  clear(): void
}

export interface MemoryOptions {
  name?: string
  /** Para simular fallos: se llama antes de guardar cada mensaje. */
  beforeSend?: (message: Message, attempt: number) => void | Promise<void>
  /** Imprime cada mensaje en consola (modo desarrollo). */
  log?: boolean
}

/** No envía nada: guarda los mensajes. Para tests y desarrollo local. */
export function memory(options: MemoryOptions = {}): MemoryTransport {
  const name = options.name ?? 'memory'
  const sent: Message[] = []
  let attempt = 0

  return {
    name,
    sent,
    clear() {
      sent.length = 0
      attempt = 0
    },
    async send(message: Message): Promise<SendResult> {
      await options.beforeSend?.(message, ++attempt)
      sent.push(message)
      if (options.log) {
        console.log(`[mailer:${name}] ${message.subject} -> ${message.to.map((a) => a.address).join(', ')}`)
      }
      return {
        messageId: `<${randomUUID()}@memory>`,
        transport: name,
        accepted: [...message.to, ...message.cc, ...message.bcc].map((a) => a.address),
        rejected: [],
      }
    },
  }
}
