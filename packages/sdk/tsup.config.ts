import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    math: 'src/math/index.ts',
    model: 'src/model/index.ts',
    evidence: 'src/evidence/index.ts',
    'pm-amm': 'src/pm-amm/index.ts',
    program: 'src/program/index.ts',
    client: 'src/client/index.ts',
    errors: 'src/errors-entry.ts',
    replay: 'src/replay.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  target: 'es2022',
  external: ['@solana/web3.js', '@solana/spl-token'],
})
