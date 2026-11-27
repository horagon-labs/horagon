// How deep a pool is as the game goes on: the price move of a 10 and a 100 mUSDC buy on a 50% pool
// against minutes since tip-off. pm-AMM's liquidity decays on wall-clock time to a fixed end_ts
// (L_eff = L0 * sqrt(T - t)), not with the game clock, so the same buy moves the price more as
// end_ts nears. Built on the curve and quote port (`math/curve`, `math/quote`).
import { lEffective, reservesFromPrice } from '../math/curve'
import { pdf } from '../math/normal'
import { quoteSwap } from '../math/quote'

/** Kind-0 end_ts today: S + 3h00m (the keeper's `endOffsetSecs`). */
export const END_OFFSET_SECS = 10_800
/** Kind-0 end_ts before the buzzer close: S + 2h10m. */
export const END_OFFSET_BEFORE_R1_SECS = 7_800
/** Markets are created this long before tip-off (the keeper's `createLeadSecs`). */
export const CREATE_LEAD_SECS = 3_600
/** A regular game's seed, in mUSDC. */
export const REGULAR_SEED_USDC = 300
/** The buys the curve prices, in mUSDC. */
export const DEPTH_BUYS_USDC = [10, 100] as const
/**
 * The median Final, in minutes after the scheduled tip-off, over 268 recorded games (the end_ts
 * spike re-run of 2026-11-26).
 */
export const MEDIAN_FINAL_MINUTES = 151.6

/**
 * L0 of a pool seeded with `seedUsdc` at 50%, `secsToEnd` before its end: the deposit covers the
 * larger reserve, which at 50% is L_eff * phi(0) on both sides.
 */
export function lZeroAtHalf(seedUsdc: number, secsToEnd: number): number {
  return (seedUsdc * 1e6) / pdf(0) / Math.sqrt(secsToEnd)
}

export interface DepthPoint {
  /** Minutes since the scheduled tip-off. */
  minute: number
  /** The pool's depth (L_eff) as a share of its depth when it was created. */
  depthShare: number
  /** YES price move (0..1) of a 10 mUSDC buy at 50%, fee taken; null when the pool cannot fill it. */
  move10: number | null
  /** The same for a 100 mUSDC buy. */
  move100: number | null
}

export interface DepthCurve {
  endOffsetSecs: number
  points: DepthPoint[]
}

export interface DepthCurveInput {
  endOffsetSecs: number
  createLeadSecs?: number
  seedUsdc?: number
  stepMinutes?: number
}

function moveOf(
  pool: Parameters<typeof quoteSwap>[0]['pool'],
  usdc: number,
  now: number,
): number | null {
  try {
    const q = quoteSwap({ pool, direction: 'usdcToYes', amountIn: BigInt(usdc * 1e6), now })
    return q.priceAfter - q.priceBefore
  } catch {
    return null
  }
}

/** One point every `stepMinutes` from tip-off while the pool is still open. */
export function depthCurve(input: DepthCurveInput): DepthCurve {
  const { endOffsetSecs } = input
  const lead = input.createLeadSecs ?? CREATE_LEAD_SECS
  const step = input.stepMinutes ?? 5
  const lZero = lZeroAtHalf(input.seedUsdc ?? REGULAR_SEED_USDC, lead + endOffsetSecs)
  const points: DepthPoint[] = []
  for (let minute = 0; minute * 60 < endOffsetSecs; minute += step) {
    const t = minute * 60
    const remaining = endOffsetSecs - t
    const r = reservesFromPrice(0.5, lEffective(lZero, remaining))
    const pool = {
      lZero,
      reserveYes: r.x,
      reserveNo: r.y,
      lastAccrualTs: t,
      endTs: endOffsetSecs,
      hasLiquidity: true,
      resolved: false,
    }
    const [buy10, buy100] = DEPTH_BUYS_USDC
    points.push({
      minute,
      depthShare: Math.sqrt(remaining / (lead + endOffsetSecs)),
      move10: moveOf(pool, buy10, t),
      move100: moveOf(pool, buy100, t),
    })
  }
  return { endOffsetSecs, points }
}
