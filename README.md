# @juanparrado19/mailer

Envío de correos reutilizable para todos los proyectos. Se usa de dos formas:

- **Como librería**, dentro de cualquier app Node: `mailer.send({...})`.
- **Como servicio**, desplegado una vez y compartido por varios proyectos: API HTTP con
  API keys, formularios públicos para webs estáticas y colas para miles de correos.

Las dos comparten el mismo núcleo: transportes intercambiables (SMTP, Resend o uno
propio), plantillas, validación, reintentos y failover entre proveedores.

```
                 ┌────────────── librería ──────────────┐
  tu app ──────▶ │ createMailer → plantillas → reintentos│──▶ SMTP / Resend / …
                 └──────────────────────────────────────┘
                                   ▲
  webs estáticas ─▶ /v1/forms/:id  │           ┌─ worker ─┐
  otros backends ─▶ /v1/send       ├─▶ cola ──▶├─ worker ─┤──▶ proveedor
  campañas ───────▶ /v1/batch      │  (Redis)  └─ worker ─┘
                   mailer-server (API)
```

## Instalación

El paquete se publica en **GitHub Packages**, de forma privada. En cada proyecto que lo use,
crea un `.npmrc`:

```ini
@juanparrado19:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` es un token personal con permiso `read:packages`, en tu entorno o en los
secrets de CI.

```bash
npm install @juanparrado19/mailer
# Solo si vas a usar la cola Redis:
npm install bullmq ioredis
```

Requiere Node 20 o superior. Funciona con `import` y con `require`.

## 1. Librería

```ts
import { createMailer, smtp } from '@juanparrado19/mailer'

const mailer = createMailer({
  transport: smtp({
    host: 'smtp.hostinger.com',
    auth: { user: 'info@paramoprograming.com', pass: process.env.SMTP_PASS! },
  }),
  from: 'ParamoPrograming <info@paramoprograming.com>',
})

await mailer.send({
  to: 'cliente@gmail.com',
  replyTo: 'soporte@paramoprograming.com',
  subject: 'Tu cotización',
  html: '<p>Hola…</p>',
  text: 'Hola…',
})
```

### Plantillas

```ts
const mailer = createMailer({
  transport,
  from: 'info@paramoprograming.com',
  globals: { company: 'ParamoPrograming' },           // disponibles en todas
  templates: {
    welcome: {
      subject: 'Bienvenido a {{company}}, {{user.name}}',
      html: '<h1>Hola {{user.name}}</h1>{{{footerHtml}}}',  // {{ }} escapa, {{{ }}} no
      text: 'Hola {{user.name}}',
    },
    // O una función: usa React Email, MJML, Handlebars…
    receipt: async (data) => ({ subject: `Recibo #${data.id}`, html: await render(data) }),
  },
})

await mailer.send({ to: 'ana@x.com', template: 'welcome', data: { user: { name: 'Ana' } } })
```

`{{ var }}` escapa el HTML (un nombre con `<script>` no se ejecuta en el correo). En el asunto
se eliminan los saltos de línea, para que nadie pueda inyectar cabeceras.

### Varios proveedores y failover

```ts
import { createMailer, smtp, resend } from '@juanparrado19/mailer'

const mailer = createMailer({
  transport: [
    smtp({ name: 'hostinger', host: 'smtp.hostinger.com', auth }),
    resend({ name: 'resend', apiKey: process.env.RESEND_API_KEY! }),
  ],
  defaultTransport: ['hostinger', 'resend'], // si Hostinger falla con error temporal → Resend
})

await mailer.send({ ...msg, transport: 'resend' })  // o elegir por mensaje
```

Solo se hace failover con errores **temporales**: red caída, SMTP 4xx, HTTP 429 o 5xx. Los
**permanentes** (buzón inexistente, credenciales, SMTP 5xx) cortan en el acto, porque otro
proveedor no los arreglaría. Todos los errores son `MailerError`, con `code`, `retryable`
y `providerCode`.

### Muchos correos desde la librería

```ts
const results = await mailer.sendMany(messages, { concurrency: 5 })
// Nunca lanza: [{ ok: true, result } | { ok: false, error }] en el mismo orden.
```

Esto sirve para decenas o cientos de correos. Para miles, o si no pueden perderse aunque
el proceso se reinicie, usa una cola (sección 2).

### Transporte propio

Cualquier proveedor se añade implementando una interfaz:

```ts
import type { Transport } from '@juanparrado19/mailer'

const ses: Transport = {
  name: 'ses',
  async send(message) {
    // message: from, to[], cc[], bcc[], replyTo, subject, html, text, headers, attachments…
    const id = await miClienteSES.enviar(message)
    return { messageId: id, transport: 'ses', accepted: message.to.map((a) => a.address), rejected: [] }
  },
}
```

Para que el failover y las colas funcionen, lanza `new MailerError('TRANSPORT_ERROR', msg, { retryable })`.

### Tests en tus proyectos

```ts
import { createMailer, memory } from '@juanparrado19/mailer'

const transport = memory()
const mailer = createMailer({ transport, from: 'test@x.com' })
await registrarUsuario(mailer, 'ana@x.com')
expect(transport.sent[0].subject).toBe('Bienvenida')
```

`memory({ log: true })` imprime los correos en consola: sirve en desarrollo para no enviar nada.

## 2. Colas

```ts
import { createMemoryQueue, createRedisQueue, createRedisWorker } from '@juanparrado19/mailer/queue'
```

| | `createMemoryQueue` | `createRedisQueue` + `createRedisWorker` |
| --- | --- | --- |
| Infraestructura | Ninguna | Redis |
| Si el proceso se reinicia | Se pierde lo pendiente | Se conserva |
| Escalar | Un proceso | N procesos o máquinas |
| `limiter` | Por proceso | **Global** entre todos los workers |

Las dos tienen la misma interfaz: `add`, `addBulk`, `getJob`, `counts` y `close`.

```ts
// Productor (tu API): solo encola, responde enseguida.
const queue = await createRedisQueue({ connection: process.env.REDIS_URL!, attempts: 5 })
await queue.add({ to: 'a@x.com', template: 'welcome', data }, { priority: 0 })
await queue.add(campaignMessage, { priority: 10, delayMs: 60_000 })  // menor número = antes

// Worker (otro proceso, tantos como quieras):
await createRedisWorker({
  connection: process.env.REDIS_URL!,
  mailer,
  concurrency: 10,
  limiter: { max: 10, durationMs: 1000 },  // ≤ 10 correos/s entre TODOS los workers
})
```

- **Reintentos**: los errores temporales se reintentan con espera exponencial; los
  permanentes se marcan como fallidos al primer intento, sin gastar cuota.
- **Idempotencia**: `idempotencyKey` (o `{ id }` al encolar) evita duplicados. Si el cliente
  reintenta la petición, el correo no sale dos veces.

## 3. Servicio (`mailer-server`)

Un servicio desplegado una vez. Tus proyectos le hablan por HTTP y no necesitan
credenciales SMTP.

```bash
cp examples/mailer.config.example.mjs mailer.config.mjs   # y edítalo
npx mailer-server --config mailer.config.mjs               # rol "all"
npx mailer-server gen-key                                   # genera una API key y su hash
```

La configuración completa y comentada está en
[examples/mailer.config.example.mjs](examples/mailer.config.example.mjs). En resumen:

```js
import { defineConfig } from '@juanparrado19/mailer/server'

export default defineConfig({
  transports: { hostinger: { type: 'smtp', host: 'smtp.hostinger.com', auth: {…}, pool: { rateLimit: 5 } } },
  from: 'ParamoPrograming <info@paramoprograming.com>',
  queue: { driver: 'memory' },                    // o { driver: 'redis', connection, limiter }
  templates: { … },
  apiKeys: [{ id: 'psicolab', keyHash: '…', allowedFrom: ['@paramoprograming.com'] }],
  forms: { 'rvrox-inquiry': { to: '…', subject: '…', allowedOrigins: ['https://…'], fields: {…} } },
})
```

### API

Todas las rutas `/v1/*`, salvo los formularios, llevan `Authorization: Bearer <api key>`.

**`POST /v1/send`**: un correo. Responde `202 { id }` cuando queda encolado.

```json
{
  "to": "cliente@gmail.com",
  "template": "welcome",
  "data": { "name": "Ana" },
  "idempotencyKey": "user-123-welcome",
  "sendAt": "2026-10-01T14:00:00Z",
  "priority": 0
}
```

Acepta cualquier campo de `MessageInput`: `from`, `cc`, `bcc`, `replyTo`, `subject`, `html`,
`text`, `headers`, `attachments` (en base64), `tags` y `transport`. El mensaje se valida
**antes** de encolarse: un error sale como `400` al momento, no más tarde en la cola.

**`POST /v1/batch`**: hasta 1000 por llamada. Dos formas:

```jsonc
{ "messages": [ { "to": "…", "subject": "…", "text": "…" }, … ] }

// Campaña: una plantilla y datos por destinatario
{
  "template": "promo",
  "data": { "discount": "20%" },
  "recipients": [
    { "to": "ana@x.com", "data": { "name": "Ana" } },
    { "to": "beto@x.com", "data": { "name": "Beto" }, "idempotencyKey": "promo-oct-beto" }
  ]
}
```

Responde `{ queued: [{ index, id }], errors: [{ index, error }] }`. Los inválidos se
informan y el resto se envía igual.

**`GET /v1/jobs/:id`**: estado (`waiting`, `delayed`, `active`, `completed` o `failed`),
intentos, resultado y error. Cada API key solo ve sus propios trabajos.

**`GET /health`**: estado del servicio y contadores de la cola.

### Formularios para webs estáticas

`POST /v1/forms/:id` es público y no lleva API key. Protecciones:
- **`allowedOrigins`**: solo acepta envíos desde tu web (CORS). Sin esto el servicio avisa al arrancar.
- **Validación por campo**: requerido, largo máximo, `email`, `url`, `number` y `select` con opciones.
- **`honeypot`**: campo trampa. Si viene relleno, el servicio responde OK y no envía nada.
- **Límite por IP**: 5 por hora por defecto.
- **Reply-To**: se rellena con el campo `email` del visitante, así que responder el correo le
  llega directo a él.

Con JavaScript (React, etc.):

```ts
const res = await fetch('https://api.midominio.com/mail/v1/forms/rvrox-inquiry', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(Object.fromEntries(new FormData(form))),
})
const body = await res.json()  // 200 { ok: true } | 400 { error, fields: { email: '…' } } | 429
```

Sin JavaScript (`<form>` HTML puro): define `redirect` en el formulario.

```html
<form method="POST" action="https://api.midominio.com/mail/v1/forms/contacto">
  <input name="name" required> <input name="email" type="email" required>
  <textarea name="message" required></textarea>
  <input name="website" hidden tabindex="-1" autocomplete="off">  <!-- honeypot -->
  <button>Enviar</button>
</form>
```

## Escalar

1. **Empezar**: `queue: { driver: 'memory' }` y un solo proceso. No necesita infraestructura.
2. **Volumen o fiabilidad**: `queue: { driver: 'redis', … }`, una API y varios workers:
   ```bash
   mailer-server --role api      # recibe HTTP y encola (responde en ms)
   mailer-server --role worker   # envía; arranca tantos como necesites
   ```
   En la prueba de carga (3 workers, SMTP local), 3000 correos se encolaron en 233 ms y se
   entregaron en 1,5 s, repartidos por igual entre los workers.
3. **El límite real es el proveedor.** Un buzón de hosting compartido como Hostinger tiene
   topes diarios y por minuto, y si se superan suspende el envío. Para miles al día:
   - configura `limiter` (global en Redis) y `pool.rateLimit` por debajo del tope de tu plan;
   - usa un proveedor transaccional (Resend, o SES o Brevo con un transporte propio) y deja
     Hostinger para los correos del día a día o como respaldo con `defaultTransport`.

Los límites de la API (`rateLimit` por clave o por IP) se cuentan por instancia de API. El
caudal hacia el proveedor lo controla el `limiter`, que en Redis es global.

## Despliegue

- **pm2**, en un servidor propio como botequi: [deploy/ecosystem.config.cjs](deploy/ecosystem.config.cjs)
  y el bloque de nginx en [deploy/nginx-location.conf](deploy/nginx-location.conf). Deja
  `trustProxy: true` para que el límite por IP use la IP real.
- **Docker**, con Redis incluido:
  ```bash
  cp .env.example deploy/.env && cp examples/mailer.config.example.mjs deploy/mailer.config.mjs
  docker compose -f deploy/docker-compose.yml up -d --scale worker=4
  ```

El servicio cierra de forma ordenada con SIGTERM: deja de aceptar peticiones, termina los
envíos en curso y sale. En Redis, lo pendiente se queda en la cola.

## Publicar una versión

```bash
npm version minor          # o patch / major
git push --follow-tags     # el tag vX.Y.Z publica en GitHub Packages (workflow publish.yml)
```

## Desarrollo

```bash
npm install
npm test                   # tests (los de Redis se saltan sin REDIS_URL)
docker run --rm -d -p 6379:6379 redis:7-alpine
REDIS_URL=redis://127.0.0.1:6379 npm test   # suite completa
npm run typecheck && npm run build
```

Estructura:

```
src/
  index.ts            librería: createMailer, transportes, plantillas, errores
  mailer.ts           defaults, plantillas, validación, reintentos, failover
  transports/         smtp (nodemailer, pool), resend (HTTP), memory (tests)
  queue/              memory.ts y redis.ts (BullMQ), misma interfaz
  server/             HTTP: API keys, /v1/send, /v1/batch, /v1/jobs, formularios
  cli.ts              mailer-server
test/                 vitest; SMTP real contra un servidor local, Resend contra un mock
deploy/               pm2, nginx, Docker, docker-compose
```
