// The crown's words and small rules (Chronometer spec 3.3), first lifted out of the old
// trade-panel.tsx: the send button, the quote's key, and which amount a direction starts from.
import type { Position, Quote, Side, TradeAction } from '@horagon/sdk'
import { parseAmount } from '@horagon/sdk/amount'
import type { TradeStage } from './trade-shared'
import { SET_UP_BUTTON } from './wallet-copy'

export const QUOTE_DEBOUNCE_MS = 300
export const QUOTE_POLL_MS = 5_000

/** The buy amount (mUSDC) a fresh crown starts at, and a buy returns to after a sell. */
export const BUY_AMOUNT = '10'

/** The wallet's position on one side of a market, only while it still holds shares there. */
export const heldOn = (
  positions: readonly Position[] | undefined,
  market: string,
  side: Side,
): Position | undefined =>
  positions?.find((p) => p.market === market && p.side === side && parseAmount(p.shares) > 0n)

/**
 * The amount after the crown turns to `to` (Task 18 ruling): the one rule for both crown chips,
 * the Pusher and the PositionCard's Sell, so a share count never becomes an mUSDC buy and an
 * mUSDC amount never a share count. A buy starts from BUY_AMOUNT; a sell starts from every share
 * `held` on its side, or '' when none are. A turn that keeps the direction keeps the amount,
 * except a sell that changes side.
 */
export function startAmount(
  to: { action: TradeAction; side: Side },
  from: { action: TradeAction; side: Side; amount: string },
  held: string | undefined,
): string {
  if (to.action === 'buy') return from.action === 'buy' ? from.amount : BUY_AMOUNT
  return from.action === 'sell' && from.side === to.side ? from.amount : (held ?? '')
}

export type Ready = 'no-wallet' | 'loading' | 'ready'

export const STAGE_TEXT: Record<TradeStage, string> = {
  building: 'Preparing…',
  signing: 'Signing…',
  submitting: 'Sending…',
  confirming: 'Confirming…',
  requoting: 'Price moved, re-quoting…',
}

/** The YES price for home, the NO price for away; null without a price. */
export const sidePrice = (price: number | null, side: Side): number | null =>
  price === null ? null : side === 'home' ? price : 1 - price

/** The usePoll key of a quote; null (no quote) until the amount is worth quoting. */
export const quoteKey = (
  market: string,
  side: Side,
  action: TradeAction,
  amount: string | null,
): string | null => (amount === null ? null : `quote:${market}:${side}:${action}:${amount}`)

/** The send button's words. */
export function sendText(
  ready: Ready,
  stage: TradeStage | null,
  action: TradeAction,
  team: string,
): string {
  if (ready === 'no-wallet') return SET_UP_BUTTON
  if (ready === 'loading') return 'Loading your balance…'
  if (stage) return STAGE_TEXT[stage]
  return `${action === 'buy' ? 'Buy' : 'Sell'} ${team}`
}

/** Off while the balance loads, and for a ready wallet with a bad form or a send in flight. */
export const sendDisabled = (ready: Ready, ok: boolean, stage: TradeStage | null): boolean =>
  ready === 'loading' || (ready === 'ready' && (!ok || stage !== null))

/** A quote tagged with the usePoll key it was loaded for. */
export interface KeyedQuote {
  key: string
  quote: Quote
}

/** The quote of the key on screen: never one loaded for another side, direction or amount. */
export const freshQuote = (data: KeyedQuote | undefined, key: string | null): Quote | undefined =>
  key !== null && data?.key === key ? data.quote : undefined

/** The newest quote kept for a side and direction (the ghost's last position). */
export interface KeptQuote {
  side: Side
  action: TradeAction
  quote: Quote
}

/**
 * The quote to keep: the fresh one when there is one, else the previous one if it is for the
 * same side and direction; nothing when there is nothing to quote. Returns `prev` itself when
 * nothing changed, so it is safe to adopt while rendering.
 */
export function keepQuote(
  prev: KeptQuote | undefined,
  fresh: Quote | undefined,
  side: Side,
  action: TradeAction,
  key: string | null,
): KeptQuote | undefined {
  if (key === null) return undefined
  const same = prev !== undefined && prev.side === side && prev.action === action
  if (fresh) return same && prev.quote === fresh ? prev : { side, action, quote: fresh }
  return same ? prev : undefined
}
