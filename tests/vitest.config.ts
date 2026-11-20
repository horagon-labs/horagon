import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['integration/**/*.test.ts'],
    // One chain, one Config PDA: the cases build on each other and run in order.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
