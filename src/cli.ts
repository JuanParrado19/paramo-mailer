// mailer-server: arranca el servicio a partir de un archivo de configuración.
//
//   mailer-server --config ./mailer.config.mjs --role all|api|worker
//   mailer-server hash-key <clave>     imprime el sha256 para `keyHash`
//   mailer-server gen-key              genera una API key aleatoria
//
// Variables: MAILER_CONFIG y MAILER_ROLE equivalen a los flags.

import { createHash, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createMailServer, type Role, type ServerConfig } from './server/index.js'

const USAGE = `Uso:
  mailer-server [--config archivo] [--role all|api|worker]
  mailer-server gen-key
  mailer-server hash-key <clave>`

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      role: { type: 'string', short: 'r' },
      help: { type: 'boolean', short: 'h' },
    },
  })

  if (values.help) return console.log(USAGE)

  const [command, arg] = positionals
  if (command === 'gen-key') {
    const key = randomBytes(32).toString('base64url')
    console.log(`key:     ${key}\nkeyHash: ${createHash('sha256').update(key).digest('hex')}`)
    return
  }
  if (command === 'hash-key') {
    if (!arg) throw new Error('Falta la clave: mailer-server hash-key <clave>')
    console.log(createHash('sha256').update(arg).digest('hex'))
    return
  }
  if (command) throw new Error(`Comando desconocido: ${command}\n\n${USAGE}`)

  const role = (values.role ?? process.env.MAILER_ROLE ?? 'all') as Role
  if (!['all', 'api', 'worker'].includes(role)) throw new Error(`Rol inválido: ${role}`)

  const configPath = resolve(values.config ?? process.env.MAILER_CONFIG ?? 'mailer.config.mjs')
  const mod = (await import(pathToFileURL(configPath).href)) as { default?: ServerConfig }
  const config = mod.default
  if (!config) throw new Error(`${configPath} debe exportar la configuración por defecto`)

  const server = await createMailServer(config, { role })
  await server.listen()

  // Cierre ordenado: pm2, systemd y Docker mandan SIGTERM y esperan.
  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    console.log(JSON.stringify({ level: 'info', message: 'server.stopping', signal }))
    const force = setTimeout(() => process.exit(1), 30_000)
    force.unref()
    await server.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  console.error(JSON.stringify({ level: 'error', message: 'fatal', error: (err as Error).message }))
  process.exit(1)
})
