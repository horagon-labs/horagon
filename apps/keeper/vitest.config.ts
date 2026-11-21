import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Entry points and RPC glue are exercised by the local end-to-end run on Surfpool, not here.
      exclude: ['src/main.ts', 'src/ops/cli.ts'],
      thresholds: {
        lines: 70,
        'src/planner.ts': { lines: 95 },
        'src/feeds/**': { lines: 90 },
      },
    },
  },
})
