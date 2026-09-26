import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'queue/index': 'src/queue/index.ts',
      'server/index': 'src/server/index.ts',
    },
    format: ['esm', 'cjs'],
    // tsup añade baseUrl al generar tipos; TS 6 lo marca obsoleto.
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    sourcemap: true,
    clean: true,
    target: 'node20',
    // bullmq es peer opcional: se carga solo si se usa la cola Redis.
    external: ['bullmq', 'ioredis'],
  },
  {
    // El CLI se publica solo en ESM y con shebang para `npx mailer-server`.
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    target: 'node20',
    sourcemap: true,
    external: ['bullmq', 'ioredis'],
    banner: { js: '#!/usr/bin/env node' },
  },
])
