// What the trade button may do right now, and why not. The API and the program enforce all
// of this again; the form only saves a round trip and says it in words.
import type { GameStatus, MarketStatus, TradeAction } from '@horagon/sdk'
import { parseAmount } from '@horagon/sdk/amount'
import { BUZZER_CLOSED } from './chrono/copy'

export { BUZZER_CLOSED }

export interface TradeFormInput {
  action: TradeAction
  amount: string
  /** Wallet mUSDC; null or undefined while unknown (the API decides then). */
  balance: string | null | undefined
  /** Shares held on the chosen side; undefined for none. */
  shares: string | undefined
  marketStatus: MarketStatus
  /** The game's status: a final game trades no more, halted or not yet (R1, R5c). */
  gameStatus?: GameStatus
  /**
   * The horn frame (lib/chrono/stop.ts): the close at the buzzer (R8), halted or before the
   * keeper's halt lands, as a final game.
   */
  hornFrame?: boolean
  endTs: number
  nowSecs: number
}

export interface TradeCheck {
  ok: boolean
  /** Worth asking for a quote (the amount parses and the market trades). */
  quote: boolean
  reason?: string
  /** The fix is the faucet. */
  fund?: boolean
}

const AMOUNT = /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/

export function checkTrade(i: TradeFormInput): TradeCheck {
  // The final buzzer closes trading, also before the keeper's halt reaches the index (R5c).
  if (i.gameStatus === 'final') return { ok: false, quote: false, reason: BUZZER_CLOSED }
  if (i.hornFrame) return { ok: false, quote: false, reason: BUZZER_CLOSED }
  if (i.marketStatus === 'halted') {
    return { ok: false, quote: false, reason: 'Trading is halted.' }
  }
  if (i.marketStatus !== 'open' || i.nowSecs >= i.endTs) {
    return { ok: false, quote: false, reason: 'Trading on this market has closed.' }
  }
  const text = i.amount.trim()
  if (!AMOUNT.test(text)) {
    return {
      ok: false,
      quote: false,
      reason: 'Enter an amount like 25 or 12.5 (at most 6 decimals).',
    }
  }
  const raw = parseAmount(text)
  if (raw === 0n) return { ok: false, quote: false, reason: 'Enter an amount above 0.' }
  if (i.action === 'buy') {
    if (i.balance !== null && i.balance !== undefined && raw > parseAmount(i.balance)) {
      return { ok: false, quote: true, reason: 'Not enough mUSDC.', fund: true }
    }
    return { ok: true, quote: true }
  }
  const held = i.shares === undefined ? 0n : parseAmount(i.shares)
  if (raw > held) {
    return {
      ok: false,
      quote: held > 0n,
      reason: held === 0n ? 'You hold no shares on this side.' : `You hold ${i.shares} shares.`,
    }
  }
  return { ok: true, quote: true }
}

/**
 * Whether the trade button can act yet. `no-wallet`: the gate has not created a burner.
 * `loading`: this signer's portfolio has not loaded once, so the balance is unknown and a Buy
 * would only be checked by the API. `ready` otherwise.
 */
export function tradeReady(
  address: string | null,
  portfolio: { wallet: string } | undefined,
): 'no-wallet' | 'loading' | 'ready' {
  if (address === null) return 'no-wallet'
  return portfolio?.wallet === address ? 'ready' : 'loading'
}
