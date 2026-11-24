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

/** Whole seconds until a rate-limited send may go again, from when the error was seen. */
export function retryLeft(err: unknown, seenAt: number, now: number): number {
  if (!isHoragonError(err)) return 0
  const wait = err.retryAfterSecs
  if (wait === undefined || !Number.isFinite(wait)) return 0
  return Math.max(0, Math.ceil(seenAt + wait - now))
}
