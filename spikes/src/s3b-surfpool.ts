// Spike S3(b): the same lifecycle as S1 on a local Surfpool fork of devnet. pm-AMM and
// Metaplex must load from devnet on first use; collateral is a fresh local mint; the clock
// is moved with surfnet_timeTravel instead of waiting.

import { METAPLEX_PROGRAM_ID, PM_AMM_PROGRAM_ID } from '@horagon/sdk/pm-amm'
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token'
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { chainUnixTime, waitForSignature } from './lib/chain'
import { connect, rpcUrl } from './lib/env'
import { runSpike, SpikeRun } from './lib/results'
import { surfnetTimeTravel } from './lib/surfnet'
import { runLifecycle } from './lifecycle'

const run = new SpikeRun('s3b-surfpool', 'local')

await runSpike(run, async () => {
  const connection = await connect('local')
  const url = rpcUrl('local')

  for (const [name, id] of [
    ['pm-AMM', PM_AMM_PROGRAM_ID],
    ['Metaplex Token Metadata', METAPLEX_PROGRAM_ID],
  ] as const) {
    const info = await connection.getAccountInfo(id)
    run.check(`${name} program is available on the fork`, info?.executable === true)
  }

  // Throwaway local wallets; Surfpool airdrops freely.
  const creator = Keypair.generate()
  const trader = Keypair.generate()
  for (const kp of [creator, trader]) {
    await waitForSignature(
      connection,
      await connection.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL),
    )
  }

  // Local collateral: a 6-decimal mint the creator controls.
  const mint = await createMint(connection, creator, creator.publicKey, null, 6)
  for (const [kp, amount] of [
    [creator, 10_000_000_000n],
    [trader, 1_000_000_000n],
  ] as const) {
    const ata = await getOrCreateAssociatedTokenAccount(connection, creator, mint, kp.publicKey)
    await mintTo(connection, creator, mint, ata.address, creator, amount)
  }
  run.record('collateralMint', mint.toBase58())

  // The vendored createMarket derives end_ts from Date.now(), so the fork's clock must track
  // wall time at start. Prove time travel with a small jump that keeps end_ts valid.
  const t0 = await chainUnixTime(connection)
  const skew = t0 - Math.floor(Date.now() / 1000)
  run.check('Surfnet clock starts within 60 s of wall time', Math.abs(skew) < 60, `skew ${skew} s`)
  await surfnetTimeTravel(url, connection, t0 + 30)
  const t1 = await chainUnixTime(connection)
  run.check('surfnet_timeTravel moves the Clock sysvar forward', t1 >= t0 + 30, `${t0} -> ${t1}`)

  await runLifecycle(
    {
      connection,
      creator,
      trader,
      collateralMint: mint,
      durationSecs: 600,
      seedUsdc: 500,
      advanceTo: (t) => surfnetTimeTravel(url, connection, t),
    },
    run,
  )
})
