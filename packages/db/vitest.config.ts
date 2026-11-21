import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/migrate-cli.ts', 'src/reset-e2e-cli.ts'],
      thresholds: { lines: 70 },
    },
  },
})
