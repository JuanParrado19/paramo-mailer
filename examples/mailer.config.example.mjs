// Configuración de ejemplo de mailer-server. Cópiala como mailer.config.mjs
// (está en .gitignore) y ajusta. Los secretos vienen de variables de entorno.
//
//   mailer-server --config mailer.config.mjs

import { defineConfig } from '@juanparrado19/mailer/server'

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback
  if (value === undefined) throw new Error(`Falta la variable de entorno ${name}`)
  return value
}

export default defineConfig({
  port: Number(env('PORT', 8080)),
  host: env('HOST', '127.0.0.1'),
  // Detrás de nginx: la IP real llega en X-Real-IP.
  trustProxy: true,

  // Proveedores disponibles. El nombre de la clave es el que se usa en
  // `transport`, en las API keys y en los formularios.
  transports: {
    hostinger: {
      type: 'smtp',
      host: 'smtp.hostinger.com',
      port: 465,
      auth: { user: 'info@paramoprograming.com', pass: env('HOSTINGER_SMTP_PASS') },
      // Conexiones reutilizadas y techo de envíos: un buzón de hosting tiene
      // límites diarios y por minuto; si se superan, bloquea la cuenta.
      pool: { maxConnections: 2, rateLimit: 5, rateDeltaMs: 1000 },
    },
    // Descomenta para volumen (campañas, miles al día):
    // resend: { type: 'resend', apiKey: env('RESEND_API_KEY') },
  },
  // Cadena por defecto: si Hostinger falla con un error temporal, prueba Resend.
  defaultTransport: ['hostinger' /* , 'resend' */],
  from: 'ParamoPrograming <info@paramoprograming.com>',

  // Cola en memoria: cero infraestructura, para empezar.
  queue: { driver: 'memory', concurrency: 3, attempts: 5 },
  // Para escalar: Redis + procesos worker aparte (ver README).
  // queue: {
  //   driver: 'redis',
  //   connection: env('REDIS_URL', 'redis://127.0.0.1:6379'),
  //   concurrency: 10,
  //   // Límite global entre todos los workers (lo que permita el proveedor).
  //   limiter: { max: 10, durationMs: 1000 },
  // },

  globals: { company: 'ParamoPrograming', site: 'https://paramoprograming.com' },
  templates: {
    welcome: {
      subject: 'Welcome to {{company}}, {{name}}',
      html: '<h1>Hi {{name}}</h1><p>Thanks for joining. Visit <a href="{{site}}">{{site}}</a>.</p>',
      text: 'Hi {{name}}, thanks for joining. {{site}}',
    },
    // Una plantilla también puede ser una función (React Email, MJML…):
    // receipt: async (data) => ({ subject: `Receipt #${data.id}`, html: await render(<Receipt {...data} />) }),
  },

  // Un proyecto = una API key. Genera claves con: npx mailer-server gen-key
  apiKeys: [
    {
      id: 'psicolab',
      keyHash: env('PSICOLAB_KEY_HASH'),
      // Solo puede enviar como remitentes de su dominio.
      allowedFrom: ['@paramoprograming.com'],
      rateLimit: { max: 600, windowMs: 60_000 },
    },
  ],

  // Formularios públicos: el navegador postea directo, sin API key.
  forms: {
    'rvrox-inquiry': {
      to: 'rvroxminitrack@gmail.com',
      subject: 'New inquiry from {{name}}',
      allowedOrigins: ['https://rvroxminitrack.com'],
      honeypot: 'website',
      rateLimit: { max: 5, windowMs: 60 * 60 * 1000 },
      fields: {
        name: { required: true, maxLength: 100 },
        email: { type: 'email', required: true },
        phone: { type: 'tel', maxLength: 40 },
        service: { maxLength: 100 },
        message: { type: 'textarea', label: 'Project details', required: true },
      },
    },
  },
})
