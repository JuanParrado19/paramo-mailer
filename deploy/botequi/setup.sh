#!/usr/bin/env bash
# Instala o actualiza mailer-server en botequi. Repetible.
#
# Desde la raíz del repo, en tu PC:
#   npm pack --pack-destination deploy/botequi
#   scp deploy/botequi/{juanparrado19-mailer-*.tgz,mailer.config.mjs,ecosystem.config.cjs,setup.sh} \
#       juanpa@192.168.2.252:/var/www/mailer/
#   ssh -t juanpa@192.168.2.252 'bash /var/www/mailer/setup.sh'
#
# La primera vez pide la contraseña SMTP; para cambiarla: setup.sh --password
set -euo pipefail

DIR=/var/www/mailer
CONFIG="$DIR/ecosystem.config.cjs"
cd "$DIR"

TARBALL=$(ls -t juanparrado19-mailer-*.tgz | head -1)
echo "== Paquete: $TARBALL"
# package.json propio de la instancia: el paquete sale del tarball local, así
# el servidor no necesita token de GitHub Packages ni compilar nada.
cat > package.json <<JSON
{
  "name": "mailer-botequi",
  "private": true,
  "type": "module",
  "dependencies": { "@juanparrado19/mailer": "file:./$TARBALL" }
}
JSON
rm -f package-lock.json
npm install --omit=dev --no-audit --no-fund
# Tarballs de versiones anteriores ya no hacen falta.
for f in juanparrado19-mailer-*.tgz; do [ "$f" = "$TARBALL" ] || rm -f "$f"; done

if [ ! -s "$DIR/.smtp-pass" ] || [ "${1:-}" = "--password" ]; then
  echo "== Credenciales"
  read -rsp "Contraseña SMTP de info@paramoprograming.com: " SMTP_PASS
  echo
  ( umask 077; printf '%s' "$SMTP_PASS" > "$DIR/.smtp-pass" )
  unset SMTP_PASS
fi
chmod 600 "$DIR/.smtp-pass"

echo "== pm2"
pm2 startOrRestart "$CONFIG" --update-env
pm2 save
sleep 4
pm2 logs mailer --lines 5 --nostream
curl -fsS http://127.0.0.1:9005/health && echo
