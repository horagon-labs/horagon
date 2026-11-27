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
    // Browser pages read amounts and the play-money line without web3.js (R5c).
    amount: 'src/amount.ts',
    notice: 'src/notice.ts',
    // The night's ET date for a browser page, without web3.js (R7).
    et: 'src/et.ts',
    // The mechanism study: scores, depth curve and LP simulation, without web3.js (R10).
    study: 'src/study/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  target: 'es2022',
  external: ['@solana/web3.js', '@solana/spl-token'],
})
