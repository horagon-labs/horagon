// The pm-AMM lifecycle shared by S1 (devnet, real waits) and S3(b) (Surfpool, time travel):
// create -> swap all six directions -> claim LP residuals -> withdraw all -> swap must fail
// with InsufficientLiquidity -> resolve -> claim winnings. Every swap is re-quoted with
// `quoteSwap` from the market state just before it, and compared to the on-chain result.
import type { SwapDirection } from '@horagon/pm-amm-vendor'
import { quoteSwap } from '@horagon/sdk/math'
import {
  decodeMarket,
  deriveNoMint,
  deriveYesMint,
  fromProgramError,
  toPoolState,
} from '@horagon/sdk/pm-amm'
import { type Connection, type Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { chainUnixTime, tokenBalance, tokenDelta, txStats } from './lib/chain'
import { pmAmmClient } from './lib/pmamm'
import type { SpikeRun } from './lib/results'

/** Spec 14, S1: the quote must match the chain within 0.1%. */
export const QUOTE_TOLERANCE = 0.001

export interface LifecycleEnv {
  connection: Connection
  creator: Keypair
  trader: Keypair
  collateralMint: PublicKey
  durationSecs: number
  seedUsdc: number
  /** Block until the cluster clock reaches `unixSecs` (devnet waits; Surfpool time-travels). */
  advanceTo(unixSecs: number): Promise<void>
}

/** One swap as recorded for `packages/sdk/test/fixtures/s1-swaps.json`. */
export interface SwapSample {
  direction: SwapDirection
  amountIn: string
  now: number
  marketDataBase64: string
  actualOut: string
  quotedOut: string
  relErr: number
  computeUnits: number
  signature: string
}

interface SwapStep {
  direction: SwapDirection
  amountIn(holdings: { yes: bigint; no: bigint }): bigint
}

const SWAP_PLAN: SwapStep[] = [
  { direction: 'usdcToYes', amountIn: () => 20_000_000n },
  { direction: 'usdcToNo', amountIn: () => 20_000_000n },
  { direction: 'yesToUsdc', amountIn: (h) => h.yes / 4n },
  { direction: 'noToUsdc', amountIn: (h) => h.no / 4n },
  { direction: 'yesToNo', amountIn: (h) => h.yes / 4n },
  { direction: 'noToYes', amountIn: (h) => h.no / 4n },
]

function outputMint(
  direction: SwapDirection,
  collateral: PublicKey,
  yes: PublicKey,
  no: PublicKey,
) {
  if (direction === 'yesToUsdc' || direction === 'noToUsdc') return collateral
  return direction === 'usdcToYes' || direction === 'noToYes' ? yes : no
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
}

export async function runLifecycle(env: LifecycleEnv, run: SpikeRun): Promise<SwapSample[]> {
  const { connection, creator, trader, collateralMint } = env
  const a = pmAmmClient(connection, creator, collateralMint)
  const b = pmAmmClient(connection, trader, collateralMint)

  // 1. create_market + deposit_liquidity in one transaction (vendored SDK).
  const lamportsBefore = await connection.getBalance(creator.publicKey)
  const created = await a.send.createMarket({
    name: `HRG SPIKE ${stamp()}`,
    durationSecs: env.durationSecs,
    initialPriceBps: 5000,
    depositUsdc: env.seedUsdc,
  })
  const market = new PublicKey(created.marketPda)
  const create = await txStats(connection, created.signature)
  const solCost =
    (lamportsBefore - (await connection.getBalance(creator.publicKey))) / LAMPORTS_PER_SOL
  run.record('market', market.toBase58())
  run.record('create', { ...create.stats, solCost })
  run.check('create_market + deposit_liquidity confirmed', true, created.signature)

  const yesMint = deriveYesMint(market)
  const noMint = deriveNoMint(market)
  const initial = decodeMarket((await connection.getAccountInfo(market))?.data ?? new Uint8Array())
  run.check('market authority is the creator', initial.authority.equals(creator.publicKey))

  // 2. Six swaps by a wallet that is not the authority, so both fee halves are paid out.
  const samples: SwapSample[] = []
  for (const step of SWAP_PLAN) {
    const holdings = {
      yes: await tokenBalance(connection, trader.publicKey, yesMint),
      no: await tokenBalance(connection, trader.publicKey, noMint),
    }
    const amountIn = step.amountIn(holdings)
    const pre = await connection.getAccountInfo(market, 'confirmed')
    if (!pre) throw new Error('market account vanished')
    const signature = await b.send.swap(market, step.direction, Number(amountIn), 0)
    const { stats, tx } = await txStats(connection, signature)
    const out = outputMint(step.direction, collateralMint, yesMint, noMint)
    const actualOut = tokenDelta(tx, trader.publicKey, out)
    const quote = quoteSwap({
      pool: toPoolState(decodeMarket(pre.data)),
      direction: step.direction,
      amountIn,
      now: stats.blockTime,
    })
    const relErr = Math.abs(Number(quote.amountOut - actualOut)) / Number(actualOut)
    samples.push({
      direction: step.direction,
      amountIn: amountIn.toString(),
      now: stats.blockTime,
      marketDataBase64: pre.data.toString('base64'),
      actualOut: actualOut.toString(),
      quotedOut: quote.amountOut.toString(),
      relErr,
      computeUnits: stats.computeUnits,
      signature,
    })
    run.check(
      `swap ${step.direction}: quote within 0.1% of the chain`,
      actualOut > 0n && relErr < QUOTE_TOLERANCE,
      `in ${amountIn}, chain ${actualOut}, quote ${quote.amountOut}, err ${(relErr * 100).toFixed(4)}%, ${stats.computeUnits} CU`,
    )
  }
  run.record('swaps', samples)

  // 3. LP residuals accrue as liquidity decays; claim some mid-life.
  await env.advanceTo(initial.startTs + Math.floor(env.durationSecs / 4))
  try {
    const sig = await a.send.claimLpResiduals(market)
    run.record('claimLpResidualsMidLife', (await txStats(connection, sig)).stats)
    run.check('claim_lp_residuals mid-life confirmed', true, sig)
  } catch (e) {
    const err = fromProgramError(e)
    run.check(
      'claim_lp_residuals mid-life confirmed',
      false,
      `${err.code} ${err.programCode ?? ''}`,
    )
  }

  // 4. The only kill switch: the sole LP withdraws everything.
  const lp = await a.fetchLpPosition(market, creator.publicKey)
  if (!lp) throw new Error('creator has no LP position')
  const withdrawSig = await a.send.withdrawLiquidity(market, lp.shares)
  run.record('withdrawAll', (await txStats(connection, withdrawSig)).stats)
  const drained = decodeMarket((await connection.getAccountInfo(market))?.data ?? new Uint8Array())
  run.check(
    'withdraw_liquidity(all) leaves l_zero = 0',
    drained.lZero === 0n,
    `l_zero raw ${drained.lZero}`,
  )

  try {
    await b.send.swap(market, 'usdcToYes', 1_000_000, 0)
    run.check('swap after full withdrawal is refused', false, 'the swap went through')
  } catch (e) {
    const err = fromProgramError(e)
    run.check(
      'swap after full withdrawal -> MARKET_HALTED (6004 InsufficientLiquidity)',
      err.code === 'MARKET_HALTED' && err.programCode === 6004,
      `${err.code} ${err.programCode ?? ''}`,
    )
  }

  // 5. Resolve after end_ts, then everyone claims.
  await env.advanceTo(initial.endTs + 1)
  run.record('chainTimeAtResolve', await chainUnixTime(connection))
  const resolveSig = await a.send.resolveMarket(market, 'yes')
  run.record('resolve', (await txStats(connection, resolveSig)).stats)
  const resolved = decodeMarket((await connection.getAccountInfo(market))?.data ?? new Uint8Array())
  run.check('resolve_market(YES) recorded', resolved.resolved && resolved.winningSide === 1)

  for (const [label, keypair, client] of [
    ['trader', trader, b],
    ['creator', creator, a],
  ] as const) {
    const yes = await tokenBalance(connection, keypair.publicKey, yesMint)
    if (yes === 0n) {
      run.record(`${label}.claim`, 'no YES to claim')
      continue
    }
    const sig = await client.send.claimWinnings(market)
    const { stats, tx } = await txStats(connection, sig)
    const paid = tokenDelta(tx, keypair.publicKey, collateralMint)
    run.record(`${label}.claim`, { ...stats, yes, paid })
    run.check(
      `${label}: claim_winnings pays 1 collateral unit per YES`,
      paid === yes,
      `${yes} YES -> ${paid}`,
    )
  }

  try {
    const sig = await a.send.claimLpResiduals(market)
    run.record('claimLpResidualsAfterResolve', (await txStats(connection, sig)).stats)
  } catch (e) {
    const err = fromProgramError(e)
    run.record('claimLpResidualsAfterResolve', `${err.code} ${err.programCode ?? ''}`)
  }
  return samples
}
