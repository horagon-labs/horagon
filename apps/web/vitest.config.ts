import { defineConfig } from 'vitest/config'

export default defineConfig({
  // tsconfig keeps JSX for Next ("preserve"); the .tsx tests need React's automatic runtime.
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Components, the polling hook and the client singleton run in the browser; the local
      // end-to-end run exercises them by hand.
      include: ['lib/**/*.ts'],
      exclude: ['lib/use-poll.ts', 'lib/api.ts'],
      thresholds: { lines: 70 },
    },
  },
})
