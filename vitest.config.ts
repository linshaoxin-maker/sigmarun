import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@sigmarun/storage': fileURLToPath(new URL('./packages/storage/src/index.ts', import.meta.url)),
      '@sigmarun/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@sigmarun/dispatch': fileURLToPath(new URL('./packages/dispatch/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
    },
  },
});
