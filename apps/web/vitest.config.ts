import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Next resolves `server-only` to an empty module on the server; the tests run there too.
      'server-only': fileURLToPath(
        new URL('./node_modules/next/dist/compiled/server-only/empty.js', import.meta.url),
      ),
    },
  },
  // tsconfig keeps JSX for Next ("preserve"); the .tsx tests need React's automatic runtime.
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // Components, the polling and trade hooks and the client singleton run in the browser;
      // the local end-to-end run exercises them by hand.
      include: ['lib/**/*.ts'],
      exclude: ['lib/use-poll.ts', 'lib/use-trade.ts', 'lib/api.ts', 'lib/server/api.ts'],
      thresholds: { lines: 70 },
    },
  },
})
