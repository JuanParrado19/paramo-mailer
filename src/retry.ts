import { isRetryable } from './errors.js'
import type { RetryOptions } from './types.js'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Espera exponencial con jitter completo: evita que muchos reintentos coincidan. */
export const backoffDelay = (attempt: number, min: number, max: number): number =>
  Math.round(Math.random() * Math.min(max, min * 2 ** (attempt - 1)))

/**
 * Ejecuta `fn` reintentando solo los errores reintentables. `attempt`
 * empieza en 1.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  { attempts = 3, minDelayMs = 500, maxDelayMs = 10_000 }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt)
    } catch (err) {
      if (attempt >= attempts || !isRetryable(err)) throw err
      await sleep(backoffDelay(attempt, minDelayMs, maxDelayMs))
    }
  }
}
