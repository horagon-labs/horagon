// What each HoragonError code does on the dial besides its words (spec 6.1). The words stay
// errorText's; a non-HoragonError only ever shows "Something went wrong. Try again.".
import { isHoragonError } from '@horagon/sdk'

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
