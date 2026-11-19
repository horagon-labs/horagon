// Spike S5: can a server fund the keeper wallet and a player wallet from the pm-AMM faucet,
// at 1,000 mUSDC per wallet per hour? Also funds the `creator` and `trader` wallets S1 uses.
import { DEVNET_MUSDC_MINT } from '@horagon/sdk/pm-amm'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { tokenBalance, waitForSignature } from './lib/chain'
import { connect } from './lib/env'
import { requestFaucet } from './lib/faucet'
import { runSpike, SpikeRun } from './lib/results'
import { loadOrCreateKeypair } from './lib/wallet'

const ONE_THOUSAND_MUSDC = 1_000_000_000n
const run = new SpikeRun('s5-faucet', 'devnet')

await runSpike(run, async () => {
  const connection = await connect('devnet')
  // `creator` plays the keeper (market authority); `trader` plays a player.
  const wallets = { creator: loadOrCreateKeypair('creator'), trader: loadOrCreateKeypair('trader') }

  for (const [label, keypair] of Object.entries(wallets)) {
    const before = await tokenBalance(connection, keypair.publicKey, DEVNET_MUSDC_MINT)
    const res = await requestFaucet(keypair.publicKey)
    run.record(`${label}.wallet`, keypair.publicKey.toBase58())
    run.record(`${label}.faucet`, res)
    if (!run.check(`${label}: faucet answers 200`, res.status === 200, `HTTP ${res.status}`)) {
      continue
    }
    const signature = (res.body as { signature?: unknown }).signature
    if (typeof signature === 'string') await waitForSignature(connection, signature)
    const after = await tokenBalance(connection, keypair.publicKey, DEVNET_MUSDC_MINT)
    run.check(
      `${label}: balance grew by exactly 1,000 mUSDC`,
      after - before === ONE_THOUSAND_MUSDC,
      `${before} -> ${after}`,
    )
    run.record(`${label}.sol`, (await connection.getBalance(keypair.publicKey)) / LAMPORTS_PER_SOL)
  }

  const again = await requestFaucet(wallets.creator.publicKey)
  run.record('creator.secondFaucet', again)
  run.check(
    'second claim within the hour is refused with 429 and Retry-After',
    again.status === 429 && again.retryAfterSecs !== undefined,
    `HTTP ${again.status}, Retry-After ${again.retryAfterSecs ?? 'missing'}`,
  )
})
