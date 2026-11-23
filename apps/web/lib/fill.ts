// What a trade really filled, known without a new endpoint or an RPC call from the browser:
// the signer's position (shares, for a buy) or balance (mUSDC, for a sell) before the trade and
// after it, both from the portfolio the page already polls. Until that number is seen, the
// success line gives the quote's number as "about", never as a fact.
import {
  formatAmount,
  type PositionsResponse,
  parseAmount,
  type Side,
  type TradeAction,
} from '@horagon/sdk'
import { usdc } from './format'

/** One signer's holding in one market side, in raw units (6 decimals). */
export interface Holding {
  shares: bigint
  /** Wallet mUSDC; null while the RPC behind the API was down. */
  usdc: bigint | null
}

/** The holding in `portfolio` (of `wallet`) for one market side; undefined when not loaded. */
export function holding(
  portfolio: PositionsResponse | undefined,
  wallet: string,
  market: string,
  side: Side,
): Holding | undefined {
  if (portfolio === undefined || portfolio.wallet !== wallet) return undefined
  const p = portfolio.positions.find((x) => x.market === market && x.side === side)
  return {
    shares: p ? parseAmount(p.shares) : 0n,
    usdc: portfolio.usdcBalance === null ? null : parseAmount(portfolio.usdcBalance),
  }
}

export interface FillInput {
  action: TradeAction
  /** Taken when the trade started. */
  before: Holding | undefined
  after: Holding | undefined
  quotedOut: bigint
  minOut: bigint
}

/**
 * The raw amount received (buy: shares, sell: mUSDC), or null when it cannot be told. A change
 * that no fill of this quote could explain (outside the slippage band around the quote: a
 * second trade or a faucet landed in between) is not taken as the fill.
 */
export function exactFill(i: FillInput): bigint | null {
  if (i.before === undefined || i.after === undefined) return null
  let delta: bigint
  if (i.action === 'buy') {
    delta = i.after.shares - i.before.shares
  } else {
    if (i.before.usdc === null || i.after.usdc === null) return null
    delta = i.after.usdc - i.before.usdc
  }
  const spread = i.quotedOut - i.minOut
  const hi = i.quotedOut + (spread > 0n ? spread : 0n)
  return delta > 0n && delta >= i.minOut && delta <= hi ? delta : null
}

/** "Bought 37.01 MEM shares." once the fill is known; "about" the quote's number before. */
export function fillLine(
  action: TradeAction,
  team: string,
  n: { quoted: string | undefined; exact: bigint | null },
): string {
  const amount =
    n.exact !== null
      ? usdc(formatAmount(n.exact))
      : n.quoted === undefined
        ? ''
        : `about ${usdc(n.quoted)}`
  const mid = amount === '' ? '' : ` ${amount}`
  return action === 'buy' ? `Bought${mid} ${team} shares.` : `Sold for${mid} mUSDC.`
}

export interface AwaitFillInput extends Omit<FillInput, 'after'> {
  /** Reads the holding now (one API request); undefined when unknown. */
  load: () => Promise<Holding | undefined>
  sleep?: (ms: number) => Promise<void>
  tries?: number
  everyMs?: number
  /** True once the line is no longer shown (a new trade, the page left). */
  cancelled?: () => boolean
}

/**
 * Reads the holding up to `tries` times, `everyMs` apart, until `exactFill` can tell the fill.
 * The shares of a position come from the indexer, a few seconds behind the chain.
 */
export async function awaitFill(i: AwaitFillInput): Promise<bigint | null> {
  const sleep = i.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const tries = i.tries ?? 8
  for (let n = 0; n < tries; n++) {
    if (n > 0) await sleep(i.everyMs ?? 2_000)
    if (i.cancelled?.()) return null
    try {
      const fill = exactFill({ ...i, after: await i.load() })
      if (fill !== null) return fill
    } catch {
      // The next read may work; the line stays "about".
    }
  }
  return null
}
