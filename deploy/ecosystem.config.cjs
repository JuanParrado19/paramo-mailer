// pm2 para un servidor propio (p. ej. botequi). Copia junto a mailer.config.mjs
// y pon los secretos en `env` (archivo en modo 600: pm2 arranca sin la shell).
//
//   pm2 start ecosystem.config.cjs && pm2 save
//
// Con cola en memoria basta la app "mailer-api" con MAILER_ROLE=all.
// Con Redis: una API y N workers; sube `instances` para enviar más rápido.
module.exports = {
  apps: [
    {
      name: 'mailer-api',
      script: './node_modules/@juanparrado19/mailer/dist/cli.js',
      args: '--config mailer.config.mjs',
      cwd: '/var/www/mailer',
      exec_mode: 'fork',
      max_memory_restart: '200M',
      kill_timeout: 30000,
      env: {
        NODE_ENV: 'production',
        MAILER_ROLE: 'api', // 'all' si la cola es en memoria
        PORT: 8080,
        // HOSTINGER_SMTP_PASS: '…',
        // REDIS_URL: 'redis://127.0.0.1:6379',
      },
    },
    {
      name: 'mailer-worker',
      script: './node_modules/@juanparrado19/mailer/dist/cli.js',
      args: '--config mailer.config.mjs',
      cwd: '/var/www/mailer',
      exec_mode: 'fork',
      instances: 2,
      max_memory_restart: '200M',
      // Da tiempo a terminar los envíos en curso al reiniciar.
      kill_timeout: 30000,
      env: {
        NODE_ENV: 'production',
        MAILER_ROLE: 'worker',
        // HOSTINGER_SMTP_PASS: '…',
        // REDIS_URL: 'redis://127.0.0.1:6379',
      },
    },
  ],
};
