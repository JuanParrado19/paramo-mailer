import type { MessageInput, SendResult } from '../types.js'

export type JobStatus = 'waiting' | 'delayed' | 'active' | 'completed' | 'failed'

export interface JobInfo {
  id: string
  status: JobStatus
  /** Intentos ya hechos. */
  attempts: number
  result?: SendResult
  /** Último error, si lo hubo. */
  error?: { message: string; code?: string }
  createdAt: number
  finishedAt?: number
}

export interface AddOptions {
  /**
   * Id del trabajo. Si ya existe uno con ese id, no se encola otro: así un
   * reintento del cliente no duplica el correo. Por defecto usa
   * `message.idempotencyKey` o un id aleatorio.
   */
  id?: string
  /** Enviar más tarde. */
  delayMs?: number
  /** Menor número = antes. Útil para que un correo transaccional adelante a una campaña. */
  priority?: number
}

export interface QueueOptions {
  /** Intentos totales por correo. Por defecto 5. */
  attempts?: number
  /** Espera base entre intentos (exponencial). Por defecto 2000 ms. */
  backoffMs?: number
}

export interface WorkerOptions {
  /** Correos enviándose a la vez en este proceso. Por defecto 5. */
  concurrency?: number
  /**
   * Tope de envíos por ventana, para respetar el límite del proveedor
   * (p. ej. `{ max: 10, durationMs: 1000 }`). En Redis es global a todos
   * los workers; en memoria, a este proceso.
   */
  limiter?: { max: number; durationMs: number }
}

export interface QueueEvents {
  completed: (job: JobInfo) => void
  failed: (job: JobInfo) => void
}

/** Lo común a ambas colas: lo que usa el código que encola. */
export interface MailQueue {
  add(message: MessageInput, options?: AddOptions): Promise<{ id: string }>
  addBulk(items: Array<{ message: MessageInput; options?: AddOptions }>): Promise<Array<{ id: string }>>
  getJob(id: string): Promise<JobInfo | undefined>
  counts(): Promise<Record<JobStatus, number>>
  close(): Promise<void>
}
