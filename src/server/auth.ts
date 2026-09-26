import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { MailerError } from '../errors.js'
import type { ApiKeyConfig } from './config.js'

export const hashKey = (key: string): Buffer => createHash('sha256').update(key).digest()

interface StoredKey {
  config: ApiKeyConfig
  hash: Buffer
}

export class ApiKeys {
  private readonly keys: StoredKey[]

  constructor(configs: ApiKeyConfig[] = []) {
    const ids = new Set<string>()
    this.keys = configs.map((config) => {
      if (!/^[\w-]{1,64}$/.test(config.id)) {
        throw new MailerError('CONFIG_ERROR', `Id de API key inválido: "${config.id}" (letras, números, - y _)`)
      }
      if (ids.has(config.id)) throw new MailerError('CONFIG_ERROR', `API key duplicada: ${config.id}`)
      ids.add(config.id)
      if (config.key) {
        // Una clave corta se adivina por fuerza bruta.
        if (config.key.length < 24) {
          throw new MailerError('CONFIG_ERROR', `La API key "${config.id}" debe tener al menos 24 caracteres`)
        }
        return { config, hash: hashKey(config.key) }
      }
      if (config.keyHash && /^[0-9a-f]{64}$/i.test(config.keyHash)) {
        return { config, hash: Buffer.from(config.keyHash, 'hex') }
      }
      throw new MailerError('CONFIG_ERROR', `La API key "${config.id}" necesita key o keyHash (sha256 hex)`)
    })
  }

  get size(): number {
    return this.keys.length
  }

  /** Devuelve la clave del `Authorization: Bearer …` o undefined. */
  authenticate(req: IncomingMessage): ApiKeyConfig | undefined {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) return undefined
    const hash = hashKey(header.slice(7).trim())
    // Se comparan todas sin cortar al encontrar una, a tiempo constante.
    let found: ApiKeyConfig | undefined
    for (const key of this.keys) {
      if (timingSafeEqual(key.hash, hash)) found = key.config
    }
    return found
  }
}

/** `a@b.com` exacto o `@b.com` para todo el dominio. */
export function isFromAllowed(address: string, allowed: string[] | undefined): boolean {
  if (!allowed) return true
  const lower = address.toLowerCase()
  return allowed.some((rule) => {
    const r = rule.toLowerCase()
    return r.startsWith('@') ? lower.endsWith(r) : lower === r
  })
}
