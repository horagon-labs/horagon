// What the Pusher shows (spec 3.2, 4.3, 6.1): the two buy buttons, the faucet button for a new
// or empty wallet, or one line once trading is over.
import { parseAmount } from '@horagon/sdk'
import { countdown } from '../format'
import type { Ready } from '../trade-view'
import type { ErrorEffect } from './errors'
import type { DialState } from './state'

export type PusherMode =
  | { kind: 'buy'; locked: boolean; note: string | null }
  | { kind: 'faucet' }
  | { kind: 'line'; text: string }
  | { kind: 'none' }

export interface PusherInput {
  state: DialState
  ready: Ready
  /** The wallet's mUSDC: null for no token account yet, undefined while unknown. */
  balance: string | null | undefined
  effect: ErrorEffect | null
  /** Seconds of trading left; null without a market. */
  secsLeft: number | null
}

/** A ready wallet with nothing to spend: null means no mUSDC account yet. */
function empty(i: PusherInput): boolean {
  if (i.ready !== 'ready' || i.balance === undefined) return false
  if (i.balance === null) return true
  try {
    return parseAmount(i.balance) === 0n
  } catch {
    return false
  }
}

export function pusherMode(i: PusherInput): PusherMode {
  switch (i.state) {
    case 'resolved':
    case 'challenged':
    case 'proposed':
    case 'void':
      return { kind: 'none' }
    case 'closed':
      return { kind: 'line', text: 'Trading closed, waiting for the result' }
    case 'halted':
      return { kind: 'buy', locked: true, note: null }
    default:
      break
  }
  if (i.secsLeft === null) return { kind: 'line', text: 'market opens 60 min before tip-off' }
  if (i.ready === 'no-wallet' || i.effect === 'faucet' || empty(i)) return { kind: 'faucet' }
  const note = i.state === 'closing' ? `closes in ${countdown(i.secsLeft, 0)}` : null
  return { kind: 'buy', locked: false, note }
}
