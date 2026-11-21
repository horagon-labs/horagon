import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The PGlite database each test builds can take over 10 s while turbo runs other suites.
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 70,
        'src/sponsor/**': { lines: 90 },
      },
    },
  },
})
