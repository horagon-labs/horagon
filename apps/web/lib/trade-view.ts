// The trade controls' words and small rules, shared by the old panel and the crown (Chronometer
// spec 3.3): lifted out of trade-panel.tsx without a change.
import type { Side, TradeAction } from '@horagon/sdk'
import type { TradeStage } from './trade'

export const QUOTE_DEBOUNCE_MS = 300
export const QUOTE_POLL_MS = 5_000

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
  if (ready === 'no-wallet') return 'Set up wallet to trade'
  if (ready === 'loading') return 'Loading your balance…'
  if (stage) return STAGE_TEXT[stage]
  return `${action === 'buy' ? 'Buy' : 'Sell'} ${team}`
}

/** Off while the balance loads, and for a ready wallet with a bad form or a send in flight. */
export const sendDisabled = (ready: Ready, ok: boolean, stage: TradeStage | null): boolean =>
  ready === 'loading' || (ready === 'ready' && (!ok || stage !== null))
