import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Building and migrating the PGlite database can take over 10 s while turbo runs other suites.
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/migrate-cli.ts', 'src/reset-e2e-cli.ts'],
      thresholds: { lines: 70 },
    },
  },
})
