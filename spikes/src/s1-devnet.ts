// Spike S1: the full pm-AMM lifecycle on devnet with the vendored SDK, plus a check of
// Horagon's quote against six real swaps. Writes the swaps as an SDK test fixture.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEVNET_MUSDC_MINT, PM_AMM_SOURCE_SHA } from '@horagon/sdk/pm-amm'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { tokenBalance, waitForChainTime } from './lib/chain'
import { connect } from './lib/env'
import { runSpike, SpikeRun } from './lib/results'
import { loadOrCreateKeypair } from './lib/wallet'
import { runLifecycle } from './lifecycle'

const FIXTURE = join(import.meta.dirname, '../../packages/sdk/test/fixtures/s1-swaps.json')
const run = new SpikeRun('s1-devnet', 'devnet')

await runSpike(run, async () => {
  const connection = await connect('devnet')
  const creator = loadOrCreateKeypair('creator')
  const trader = loadOrCreateKeypair('trader')
  const needs = [
    ['creator', creator, 600_000_000n, 0.1],
    ['trader', trader, 100_000_000n, 0.02],
  ] as const
  for (const [label, keypair, usdc, sol] of needs) {
    const haveUsdc = await tokenBalance(connection, keypair.publicKey, DEVNET_MUSDC_MINT)
    const haveSol = (await connection.getBalance(keypair.publicKey)) / LAMPORTS_PER_SOL
    if (haveUsdc < usdc || haveSol < sol) {
      throw new Error(
        `${label} ${keypair.publicKey.toBase58()} has ${haveUsdc} mUSDC raw and ${haveSol} SOL; ` +
          `needs ${usdc} and ${sol}. Run \`pnpm --filter @horagon/spikes s5\` (or wait an hour).`,
      )
    }
  }

  const samples = await runLifecycle(
    {
      connection,
      creator,
      trader,
      collateralMint: DEVNET_MUSDC_MINT,
      durationSecs: 600,
      seedUsdc: 500,
      advanceTo: (t) => waitForChainTime(connection, t),
    },
    run,
  )

  const fixture = {
    source: 'spike S1 on devnet',
    recordedAt: new Date().toISOString(),
    pmAmmSourceSha: PM_AMM_SOURCE_SHA,
    note: 'marketDataBase64 is the Market account just before the swap; now is the block time.',
    swaps: samples.map(({ direction, amountIn, now, marketDataBase64, actualOut, signature }) => ({
      direction,
      amountIn,
      now,
      marketDataBase64,
      actualOut,
      signature,
    })),
  }
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`)
  run.record('fixture', FIXTURE)
})
