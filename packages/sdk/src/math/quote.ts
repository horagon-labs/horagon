import { HoragonError } from '../errors'
import { computeSwapOutput, lEffective, priceFromReserves, type SwapDirection } from './curve'
import { feeOf, isUsdcIn, isUsdcOut } from './fees'
import { type PoolState, rescaleReserves } from './rescale'

export const DEFAULT_SLIPPAGE_BPS = 200

export interface QuoteSwapInput {
  pool: PoolState
  direction: SwapDirection
  /** Raw units the user sends: micro-USDC when buying, raw shares when selling or converting. */
  amountIn: bigint
  /** Unix seconds at which the swap is expected to execute. */
  now: number
  slippageBps?: number
}

export interface SwapQuote {
  direction: SwapDirection
  amountIn: bigint
  /** Raw micro-USDC fee: 2% of the USDC leg, 0 for YES<->NO. */
  fee: bigint
  /** Raw units the user receives, after the fee. */
  amountOut: bigint
  /** amountOut less slippage; pass it as the swap's `min_output`. */
  minOut: bigint
  /** YES price at `now`, before the trade. */
  priceBefore: number
  /** YES price after the trade. */
  priceAfter: number
  /** USDC per share for buys and sells; input shares per output share for YES<->NO. */
  avgPrice: number
  /** |priceAfter - priceBefore| in basis points of probability. */
  priceImpactBps: number
}

/**
 * Quote a pm-AMM swap the way the program executes it at `now`: accrue (rescale the
 * reserves), take the fee on the USDC leg, run the curve, floor to raw units.
 */
export function quoteSwap(input: QuoteSwapInput): SwapQuote {
  const { pool, direction, amountIn, now } = input
  const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new HoragonError(
      'INVALID_INPUT',
      `slippageBps must be an integer in [0, 10000], got ${slippageBps}`,
    )
  }
  if (amountIn <= 0n || amountIn > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HoragonError(
      'INVALID_INPUT',
      `amountIn must be in [1, 2^53 - 1] raw units, got ${amountIn}`,
    )
  }
  if (pool.resolved) throw new HoragonError('MARKET_CLOSED', 'Market is resolved')
  const remaining = pool.endTs - Math.floor(now)
  if (remaining <= 0) throw new HoragonError('MARKET_CLOSED', 'Market has expired')
  if (pool.lZero === 0 || !pool.hasLiquidity) {
    throw new HoragonError('MARKET_HALTED', 'Market has no liquidity')
  }

  const reserves = rescaleReserves(pool, now)
  const lEff = lEffective(pool.lZero, remaining)
  const feeIn = isUsdcIn(direction) ? feeOf(amountIn) : 0n
  const swapIn = amountIn - feeIn
  if (swapIn <= 0n) throw new HoragonError('INVALID_INPUT', 'Amount is too small to cover the fee')

  const result = computeSwapOutput(reserves, lEff, Number(swapIn), direction)
  const grossOut = BigInt(Math.floor(Math.max(0, result.output)))
  if (grossOut === 0n) {
    throw new HoragonError('INVALID_INPUT', 'Amount is too small: the output rounds to zero')
  }
  const feeOut = isUsdcOut(direction) ? feeOf(grossOut) : 0n
  const amountOut = grossOut - feeOut
  const minOut = (amountOut * BigInt(10_000 - slippageBps)) / 10_000n

  const priceBefore = priceFromReserves(reserves.x, reserves.y, lEff)
  const priceAfter = result.priceNew
  const avgPrice = isUsdcOut(direction)
    ? Number(amountOut) / Number(amountIn)
    : Number(amountIn) / Number(amountOut)
  return {
    direction,
    amountIn,
    fee: feeIn + feeOut,
    amountOut,
    minOut,
    priceBefore,
    priceAfter,
    avgPrice,
    priceImpactBps: Math.round(Math.abs(priceAfter - priceBefore) * 10_000),
  }
}
