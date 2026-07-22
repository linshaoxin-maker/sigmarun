import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@sigmarun/storage': fileURLToPath(new URL('./packages/storage/src/index.ts', import.meta.url)),
      '@sigmarun/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@sigmarun/dispatch': fileURLToPath(new URL('./packages/dispatch/src/index.ts', import.meta.url)),
      '@sigmarun/adapters': fileURLToPath(new URL('./packages/adapters/src/index.ts', import.meta.url)),
      '@sigmarun/watch': fileURLToPath(new URL('./packages/watch/src/index.ts', import.meta.url)),
      '@sigmarun/audit': fileURLToPath(new URL('./packages/audit/src/index.ts', import.meta.url)),
      '@sigmarun/context': fileURLToPath(new URL('./packages/context/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // Windows CI runners spend 5-10x longer on this suite's shape (a fresh git repo per test,
    // thousands of fsync'd atomic writes, real child processes); the defaults (5s/10s) produced
    // 20 pure-timeout failures with zero assertion failures on the first real matrix run.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // vitest >=4 is load-bearing for the same reason: v3 workers had a hardcoded 60s birpc
    // timeout on worker->reporter calls, and on a saturated windows runner the main process
    // could starve past it — 3x `Timeout calling "onTaskUpdate"` unhandled errors turned a
    // 395/395-green run into exit 1 (vitest#8164, fixed by vitest#8297: rpc timeout: -1).
    // Do not downgrade below 4.x without re-checking that flake class.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
    },
  },
});
