// The reference agent's decision for one market, as pure functions of what it read: whether to
// trade, which side, and how much. Everything here is table-tested; agent.ts only reads, sends
// and keeps the counters.
//
// What the model is: `games.model_prob` is the keeper's in-game HOME win probability
// (tick.ts `modelProbability`: margin = home - away, p0 = the pre-game home probability). A
// winner market (kind 0) resolves YES when the home team wins (`outcomeFor` in the SDK's
// evidence rules), so for kind 0 the model is the probability of YES, directly comparable to
// the pool's YES price. The agent trades kind 0 only.
import { type PoolState, quoteSwap } from '@horagon/sdk'
import type { AgentParams } from './config'

/** Everything the agent knows about one market this round. */
export interface MarketView {
  /** The pm-AMM market account. */
  market: string
  gameId: string
  league: string
  kind: number
  /** The keeper's DB status of the market: open | halted | proposed | challenged | ... */
  marketStatus: string
  /** The keeper's DB status of the game: scheduled | live | final | ... */
  gameStatus: string
  /** Unix seconds. */
  tipoff: number
  endTs: number
  /** Home win probability (= YES for kind 0), or null when the keeper has none. */
  modelProb: number | null
  /** When the feed read that wrote `modelProb` happened, Unix seconds. */
  modelAt: number | null
  /** Newest trade by any other wallet within the fan-lag window, Unix seconds. */
  lastFanTradeAt: number | null
  /** Raw mUSDC the agent already spent on this market, and its swaps there. */
  spent: bigint
  swaps: number
  /** YES price now, from the chain; null when the pool cannot price (halted, past end_ts). */
  price: number | null
  pool: PoolState | null
  /** Disabled after an anomaly, until the agent is restarted by hand. */
  disabled: boolean
}

export type SkipReason =
  | 'disabled'
  | 'kind'
  | 'league'
  | 'market-status'
  | 'not-live'
  | 'closing'
  | 'no-model'
  | 'stale-model'
  | 'fan-trade'
  | 'no-price'
  | 'in-band'
  | 'swap-count'
  | 'game-budget'
  | 'balance'
  | 'unreachable'
  | 'below-min'

export type Side = 'yes' | 'no'
export type BuyDirection = 'usdcToYes' | 'usdcToNo'

interface Common {
  market: string
  gameId: string
  price: number | null
  model: number | null
  /** model - price, when both are known. */
  gap: number | null
}

export type Decision =
  | (Common & { action: 'skip'; reason: SkipReason })
  | (Common & {
      action: 'swap'
      price: number
      model: number
      gap: number
      side: Side
      direction: BuyDirection
      target: number
      /** Raw mUSDC sent. */
      amountIn: bigint
      /** The swap's min_output, at the configured slippage. */
      minOut: bigint
      /** YES price after the swap, from the SDK quote. */
      expectedPrice: number
      /** The swap lands within the tolerance of the target (false: a capped, partial move). */
      reachesTarget: boolean
    })

export interface DecideContext {
  /** Unix seconds. */
  now: number
  /** The agent's raw mUSDC left for this round. */
  balance: bigint
  params: AgentParams
}

/** NBA always; PRACTICE only when AGENT_PRACTICE=1. */
export function leagueAllowed(league: string, practice: boolean): boolean {
  return league === 'NBA' || (practice && league === 'PRACTICE')
}

/** The smallest of some bigints (Math.min takes numbers only). */
function min(first: bigint, ...rest: bigint[]): bigint {
  let least = first
  for (const x of rest) if (x < least) least = x
  return least
}

export function decide(v: MarketView, ctx: DecideContext): Decision {
  const { now, params: p } = ctx
  const price = v.price
  const model = v.modelProb
  const gap = price !== null && model !== null ? model - price : null
  const common: Common = { market: v.market, gameId: v.gameId, price, model, gap }
  const skip = (reason: SkipReason): Decision => ({ ...common, action: 'skip', reason })

  if (v.disabled) return skip('disabled')
  // 1. Candidates.
  if (v.kind !== 0) return skip('kind')
  if (!leagueAllowed(v.league, p.practice)) return skip('league')
  if (v.marketStatus !== 'open') return skip('market-status')
  if (v.gameStatus !== 'live' || now < v.tipoff) return skip('not-live')
  if (now >= v.endTs - p.endBufferSecs) return skip('closing')
  if (model === null || !Number.isFinite(model) || model < 0 || model > 1) return skip('no-model')
  if (v.modelAt === null || now - v.modelAt > p.modelMaxAgeSecs) return skip('stale-model')
  // 2. Any other wallet traded recently (a fan, or a team or bot wallet: the fan-lag check counts
  // every wallet but the agent's): let that trade set the price.
  if (v.lastFanTradeAt !== null && now - v.lastFanTradeAt <= p.fanLagSecs) {
    return skip('fan-trade')
  }
  // 3. The gap.
  if (price === null || v.pool === null || gap === null) return skip('no-price')
  if (Math.abs(gap) <= p.band) return skip('in-band')
  // 4. Caps, then the size.
  if (v.swaps >= p.maxSwapsPerGame) return skip('swap-count')
  const budgetLeft = p.maxPerGame - v.spent
  if (budgetLeft < p.minSwap) return skip('game-budget')
  if (ctx.balance < p.minSwap) return skip('balance')
  const cap = min(p.maxPerSwap, budgetLeft, ctx.balance)
  const side: Side = gap > 0 ? 'yes' : 'no'
  const direction: BuyDirection = side === 'yes' ? 'usdcToYes' : 'usdcToNo'
  const target = model - Math.sign(gap) * p.stopShort
  const size = sizeSwap({ pool: v.pool, direction, target, cap, now, tolerance: p.tolerance })
  if (!size) return skip('unreachable')
  if (size.amountIn < p.minSwap) return skip('below-min')
  const q = quoteSwap({
    pool: v.pool,
    direction,
    amountIn: size.amountIn,
    now,
    slippageBps: p.slippageBps,
  })
  return {
    ...common,
    action: 'swap',
    price,
    model,
    gap,
    side,
    direction,
    target,
    amountIn: size.amountIn,
    minOut: q.minOut,
    expectedPrice: q.priceAfter,
    reachesTarget: size.reachesTarget,
  }
}

export interface SizeInput {
  pool: PoolState
  direction: BuyDirection
  /** The YES price to move to. */
  target: number
  /** Largest raw mUSDC the agent may send. */
  cap: bigint
  /** Unix seconds: the real time, so the quote uses L_eff = L0 * sqrt(end_ts - now). */
  now: number
  tolerance: number
}

export interface Size {
  amountIn: bigint
  /** YES price after the swap. */
  priceAfter: number
  /** |priceAfter - target| <= tolerance. */
  reachesTarget: boolean
}

/**
 * The buy that moves the YES price to `target` without passing it, found by bisection on the
 * SDK quote (the program's own accrual, fee and curve at `now`). Buying YES raises the price and
 * buying NO lowers it, monotonically in the amount, so the largest amount that has not passed
 * the target lands on it, to within one raw unit.
 *
 * - The cap would not reach the target: the cap, a partial move (`reachesTarget` false). The
 *   next rounds go on from there, within the per-game budget and swap count.
 * - Null when the target is unreachable within the cap: the cap is 0, the target is not on the
 *   side this buy moves the price to, or no amount up to the cap can be quoted without passing
 *   the target window (the pool is too thin, or cannot fill).
 */
export function sizeSwap(s: SizeInput): Size | null {
  if (s.cap <= 0n) return null
  const sign = s.direction === 'usdcToYes' ? 1 : -1
  const after = (amountIn: bigint): number | null => {
    try {
      return quoteSwap({ pool: s.pool, direction: s.direction, amountIn, now: s.now }).priceAfter
    } catch {
      // Too large for the pool, or too small to fill: no price there.
      return null
    }
  }
  /** At or short of the target, seen from the side this buy pushes the price to. */
  const short = (price: number | null): price is number =>
    price !== null && sign * (s.target - price) >= 0
  const size = (amountIn: bigint, priceAfter: number): Size => ({
    amountIn,
    priceAfter,
    reachesTarget: Math.abs(priceAfter - s.target) <= s.tolerance,
  })
  const atCap = after(s.cap)
  if (short(atCap)) return size(s.cap, atCap)
  let lo = 0n
  let loPrice: number | null = null
  let hi = s.cap
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n
    const price = after(mid)
    if (short(price)) {
      lo = mid
      loPrice = price
    } else {
      hi = mid
    }
  }
  if (lo === 0n || loPrice === null) return null
  // The next raw unit passes the target; only an amount the pool cannot fill stops further off.
  return size(lo, loPrice)
}
