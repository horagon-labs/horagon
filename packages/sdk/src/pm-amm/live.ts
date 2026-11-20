// Price and depth of a pm-AMM market at a given time, after the accrual the program would
// apply. Shared by the API (market state) and the keeper's indexer (price points).
import { lEffective, priceFromReserves } from '../math/curve'
import { effectiveTime, rescaleReserves } from '../math/rescale'
import { type MarketAccount, toPoolState } from './market'

export interface LiveMarket {
  /**
   * YES price at `now` in [0, 1]; 1 or 0 once resolved. Null when the pool cannot price:
   * halted (no liquidity) or past end_ts but unresolved. Callers fall back to the last
   * indexed price then.
   */
  price: number | null
  /** L_eff at `now`, raw collateral units; 0 when the pool cannot trade. */
  liquidity: number
  /** Trading has ended on chain (resolved, or past end_ts). */
  closed: boolean
}

/** Price and depth at `now`, the way the program would see them after accrual. */
export function liveMarket(m: MarketAccount, now: number): LiveMarket {
  if (m.resolved) return { price: m.winningSide === 1 ? 1 : 0, liquidity: 0, closed: true }
  const pool = toPoolState(m)
  const t = effectiveTime(now, pool.lastAccrualTs)
  if (t >= pool.endTs) return { price: null, liquidity: 0, closed: true }
  if (!pool.hasLiquidity || pool.lZero === 0) return { price: null, liquidity: 0, closed: false }
  const { x, y } = rescaleReserves(pool, t)
  const lEff = lEffective(pool.lZero, pool.endTs - t)
  const price = priceFromReserves(x, y, lEff)
  return {
    price: Number.isFinite(price) ? Math.min(1, Math.max(0, price)) : null,
    liquidity: lEff,
    closed: false,
  }
}
