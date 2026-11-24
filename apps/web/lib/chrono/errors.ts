// What each HoragonError code does on the dial besides its words (spec 6.1). The words stay
// errorText's; a non-HoragonError only ever shows "Something went wrong. Try again.".
import { isHoragonError } from '@horagon/sdk'
import { pollHealth } from './health'

/**
 * The quote poll's error for ErrorText (spec 4.4): an answer from the API, such as an amount
 * too large, shows at once; a network failure (NETWORK, or no HoragonError at all) only after
 * ERROR_AFTER failed polls in a row, like every other poll.
 */
export function quoteError(poll: {
  error: Error | undefined
  failures: number
}): Error | undefined {
  const e = poll.error
  if (e === undefined) return undefined
  if (isHoragonError(e) && e.code !== 'NETWORK') return e
  return pollHealth(poll).error
}

/**
 * refresh: reload, the dial turns closed or halted. requote: the ghost shakes, "Get a new
 * quote". faucet: the Pusher becomes the faucet button. countdown: wait out retryAfterSecs.
 */
export type ErrorEffect = 'refresh' | 'requote' | 'faucet' | 'countdown' | 'text'

export function errorEffect(err: unknown): ErrorEffect | null {
  if (err === undefined || err === null) return null
  if (!isHoragonError(err)) return 'text'
  switch (err.code) {
    case 'MARKET_CLOSED':
    case 'MARKET_HALTED':
      return 'refresh'
    case 'SLIPPAGE_EXCEEDED':
      return 'requote'
    case 'INSUFFICIENT_FUNDS':
      return 'faucet'
    case 'RATE_LIMITED':
      return err.retryAfterSecs === undefined ? 'text' : 'countdown'
    default:
      return 'text'
  }
}

/**
 * SLIPPAGE_EXCEEDED: shake the ghost and offer "Get a new quote" until a quote newer than the
 * one on screen at the error has come (M6). Both `now`s are the API's clock, so a browser clock
 * that is off changes nothing (N1). While no quote can load (`quotes` false: a closed or halted
 * market, a bad amount), there is nothing to offer (N3).
 */
export function requoteShown(
  effect: ErrorEffect | null,
  quotes: boolean,
  quote: { now: number } | undefined,
  errorQuoteNow: number,
): boolean {
  return effect === 'requote' && quotes && !(quote !== undefined && quote.now > errorQuoteNow)
}

/**
 * A faucet request answers only an INSUFFICIENT_FUNDS send (I3). Any other error stays, so a
 * failed transaction keeps its "may still land" link (R2, N6).
 */
export const clearedByFaucet = (err: unknown): boolean => errorEffect(err) === 'faucet'

/** Whole seconds until a rate-limited send may go again, from when the error was seen. */
export function retryLeft(err: unknown, seenAt: number, now: number): number {
  if (!isHoragonError(err)) return 0
  const wait = err.retryAfterSecs
  if (wait === undefined || !Number.isFinite(wait)) return 0
  return Math.max(0, Math.ceil(seenAt + wait - now))
}
