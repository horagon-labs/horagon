import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The PGlite database each test builds can take over 10 s while turbo runs other suites.
    // Tests that build it inside the test body (makeEnv per test, as app.test.ts and flags.test.ts do) spend that boot inside the per-test budget, which takes over 5 s under the same load.
    hookTimeout: 30_000,
    testTimeout: 30_000,
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
