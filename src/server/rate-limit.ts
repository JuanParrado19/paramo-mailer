import type { RateLimit } from './config.js'

/**
 * Límite de ventana deslizante en memoria. Con varias instancias de la API
 * cada una cuenta por separado: el límite efectivo se multiplica por el
 * número de instancias. El caudal real hacia el proveedor lo controla el
 * `limiter` de la cola, que en Redis sí es global.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly sweeper: NodeJS.Timeout

  constructor() {
    // Sin barrido, el Map crece con cada IP o clave que haya pasado.
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.sweeper.unref()
  }

  /** true si se permite (y lo cuenta); false si se superó el límite. */
  take(key: string, limit: RateLimit, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < limit.windowMs)
    if (recent.length >= limit.max) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    return true
  }

  private sweep(now = Date.now()) {
    // Se olvida lo inactivo durante 24 h: más que cualquier ventana razonable.
    for (const [key, times] of this.hits) {
      if (now - times[times.length - 1]! > 24 * 60 * 60 * 1000) this.hits.delete(key)
    }
  }

  stop() {
    clearInterval(this.sweeper)
  }
}
