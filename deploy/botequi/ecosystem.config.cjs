// /var/www/mailer/ecosystem.config.cjs — sin secretos: la contraseña SMTP se
// lee de .smtp-pass (modo 600), que setup.sh crea la primera vez. Así este
// archivo se puede reemplazar en cada actualización sin perderla.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

module.exports = {
  apps: [
    {
      name: 'mailer',
      script: './node_modules/@juanparrado19/mailer/dist/cli.js',
      args: '--config mailer.config.mjs --role all',
      cwd: '/var/www/mailer',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '150M',
      // Da tiempo a terminar los envíos en curso al reiniciar.
      kill_timeout: 30000,
      env: {
        NODE_ENV: 'production',
        // 9001-9004 los usan paramo, rvrox y tehc.
        PORT: 9005,
        HOSTINGER_SMTP_PASS: readFileSync(join(__dirname, '.smtp-pass'), 'utf8').trim()
      }
    }
  ]
};
