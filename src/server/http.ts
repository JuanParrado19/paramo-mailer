import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const declared = Number(req.headers['content-length'])
  if (declared > maxBytes) throw new HttpError(413, 'Payload too large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new HttpError(413, 'Payload too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** JSON o `application/x-www-form-urlencoded` (formularios HTML sin JS). */
export async function readPayload(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ data: Record<string, unknown>; isForm: boolean }> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
  const raw = await readBody(req, maxBytes)
  if (type === 'application/x-www-form-urlencoded') {
    return { data: Object.fromEntries(new URLSearchParams(raw)), isForm: true }
  }
  if (type === 'application/json' || type === '') {
    try {
      const data = JSON.parse(raw || '{}') as unknown
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
      return { data: data as Record<string, unknown>, isForm: false }
    } catch {
      throw new HttpError(400, 'Invalid JSON body')
    }
  }
  throw new HttpError(415, 'Use application/json or application/x-www-form-urlencoded')
}

export function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(body)
}

export function redirect(res: ServerResponse, location: string) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' })
  res.end()
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const real = req.headers['x-real-ip']
    if (typeof real === 'string' && real) return real.trim()
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0]!.trim()
  }
  return req.socket.remoteAddress ?? 'unknown'
}
