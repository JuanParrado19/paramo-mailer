# Imagen del servicio. La configuración se monta en /app/mailer.config.mjs.
#   docker build -f deploy/Dockerfile -t mailer .
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# bullmq e ioredis son opcionales para la librería pero el servicio los usa.
RUN npm ci --omit=dev --ignore-scripts && npm install --no-save --ignore-scripts bullmq ioredis
COPY --from=build /src/dist ./dist
# El config importa '@juanparrado19/mailer/server': se resuelve a este mismo paquete.
RUN mkdir -p node_modules/@juanparrado19 && ln -s /app node_modules/@juanparrado19/mailer
USER node
EXPOSE 8080
ENTRYPOINT ["node", "dist/cli.js", "--config", "/app/mailer.config.mjs"]
