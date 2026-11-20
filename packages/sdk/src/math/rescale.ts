import { HoragonError } from '../errors'
import {
  lEffective,
  PRICE_MAX,
  PRICE_MIN,
  priceFromReserves,
  type Reserves,
  reservesFromPrice,
} from './curve'

/** The parts of a pm-AMM `Market` account the curve needs, as plain numbers in raw units. */
export interface PoolState {
  /** L_0, in raw collateral units per sqrt(second). */
  lZero: number
  /** x, the YES reserve, in raw units. */
  reserveYes: number
  /** y, the NO reserve, in raw units. */
  reserveNo: number
  lastAccrualTs: number
  endTs: number
  /** total_lp_shares > 0 */
  hasLiquidity: boolean
  resolved: boolean
}

/**
 * The time the program prices a pool at: the caller's clock, but never before the last accrual,
 * because the program never swaps before `last_accrual_ts`. A client clock that lags the chain
 * would otherwise rescale nothing yet size L_eff from a longer remaining time. Every
 * remaining-time and L_eff computation (quotes, live market state, the UI's countdown) uses it.
 */
export function effectiveTime(now: number, lastAccrualTs: number): number {
  if (!Number.isFinite(now)) {
    throw new HoragonError('INVALID_INPUT', `now must be finite Unix seconds, got ${now}`)
  }
  return Math.max(Math.floor(now), lastAccrualTs)
}

/**
 * Port of accrual.rs `compute_accrual`: the reserves the program will see at `now`, after
 * liquidity decays from L_0*sqrt(T - last_accrual) to L_0*sqrt(T - now) at constant price.
 */
export function rescaleReserves(pool: PoolState, now: number): Reserves {
  const unchanged = { x: pool.reserveYes, y: pool.reserveNo }
  if (pool.resolved || !pool.hasLiquidity || pool.lZero === 0) return unchanged
  const clampedNow = Math.min(Math.floor(now), pool.endTs)
  if (clampedNow - pool.lastAccrualTs <= 0) return unchanged
  const remainingNew = pool.endTs - clampedNow
  if (remainingNew <= 0) return { x: 0, y: 0 }
  const lOld = lEffective(pool.lZero, pool.endTs - pool.lastAccrualTs)
  const lNew = lEffective(pool.lZero, remainingNew)
  const raw = priceFromReserves(pool.reserveYes, pool.reserveNo, lOld)
  const price = Math.min(PRICE_MAX, Math.max(PRICE_MIN, raw))
  return reservesFromPrice(price, lNew)
}
