// The one place that decides how a dial looks (spec 4.3): `deriveDialState` checks the rows of
// the table in order and the first match wins. Every "now" is chain-adjusted (spec 5.4).
import { effectiveTime, type Game, type MarketSummary, type Outcome } from '@horagon/sdk'
import { percent } from '../format'
import { dialCaption, type VerdictGame } from './copy'
import { spokenDuration } from './time'

export type DialState =
  | 'resolved'
  | 'challenged'
  | 'proposed'
  | 'void'
  | 'halted'
  | 'closed'
  | 'closing'
  | 'live'
  | 'pre'

export const DIAL_STATES: readonly DialState[] = [
  'resolved',
  'challenged',
  'proposed',
  'void',
  'halted',
  'closed',
  'closing',
  'live',
  'pre',
]

/** Row 7: five minutes or less before `end_ts`. */
export const CLOSING_SECS = 300

/**
 * The market still trades: before tip-off, live, or in its last minutes before end_ts. It closes
 * at the final buzzer (R1), end_ts at the latest. Every other state is after trading: closed or
 * halted (at the buzzer too), a result proposed, under review or final, or a void game.
 */
export const isTrading = (state: DialState): boolean =>
  state === 'pre' || state === 'live' || state === 'closing'

type GameFields = Pick<Game, 'status'>
type MarketFields = Pick<MarketSummary, 'status' | 'endTs' | 'priceTs'>

/**
 * Rows 1-3 (a result on the market) come before row 4 (a void game) on purpose: a game
 * postponed for more than 7 days resolves NO (the keeper's postponedResolveSecs), and whoever
 * holds the winning side must still see Claim all.
 *
 * Row 5 and the final buzzer (R1): the keeper halts a market on the first Final read, so a halt
 * under a final game is the normal close and reads as closed, with the final caption. Only a
 * halt while the game is still on the court is the amber "Trading halted".
 */
export function deriveDialState(
  game: GameFields,
  market: MarketFields | undefined,
  nowSecs: number,
): DialState {
  if (market?.status === 'finalized' || market?.status === 'recycled') return 'resolved'
  if (market?.status === 'challenged') return 'challenged'
  if (market?.status === 'proposed') return 'proposed'
  if (game.status === 'postponed' || game.status === 'canceled') return 'void'
  // Row 10: no market yet; it opens 60 min before tip-off.
  if (!market) return 'pre'
  if (market.status === 'halted') return game.status === 'final' ? 'closed' : 'halted'
  const now = effectiveTime(nowSecs, market.priceTs ?? 0)
  if (now >= market.endTs) return 'closed'
  if (market.endTs - now <= CLOSING_SECS) return 'closing'
  return game.status === 'scheduled' ? 'pre' : 'live'
}

/** Seconds of trading left (chain-adjusted), or null without a market. */
export function secsToClose(market: MarketFields | undefined, nowSecs: number): number | null {
  if (!market) return null
  return Math.max(0, market.endTs - effectiveTime(nowSecs, market.priceTs ?? 0))
}

/**
 * The home side's price the needle points at, or null for no needle: a void game or no market
 * hides it, a result locks it at 100 or 0, a proposal turns it toward the proposed side once
 * that side is known (the evidence JSON names it).
 */
export function needlePrice(
  state: DialState,
  market: Pick<MarketSummary, 'price' | 'outcome'> | undefined,
  proposed: Outcome | null = null,
): number | null {
  if (!market || state === 'void') return null
  if (state === 'resolved' && market.outcome) return market.outcome === 'yes' ? 1 : 0
  if (state === 'proposed' && proposed) return proposed === 'yes' ? 1 : 0
  return market.price
}

export interface DialLabelInput {
  /** The game: the needle is its home side's price (YES). */
  game: VerdictGame
  /** The winner market's result, once it has one. */
  outcome: Outcome | null
  price: number | null
  modelProb: number | null
  state: DialState
  /** Seconds until trading closes; null without a market. */
  secsLeft: number | null
}

/** `pendingSaid`: the caption already says "result pending" (after the final buzzer). */
function stateWords(i: DialLabelInput, pendingSaid: boolean): string {
  switch (i.state) {
    case 'resolved':
      return 'result final'
    case 'challenged':
      return 'result under review'
    case 'proposed':
      return 'result proposed'
    case 'void':
      return `game ${i.game.status}`
    case 'halted':
      return 'trading halted'
    case 'closed':
      return pendingSaid ? 'trading closed' : 'trading closed, result pending'
    default:
      if (i.secsLeft === null) return 'market opens 60 min before tip-off'
      // An open market closes at the final buzzer; in its last 5 min before end_ts, at end_ts.
      return i.state === 'closing'
        ? `closes in ${spokenDuration(i.secsLeft)}`
        : 'open until the final buzzer'
  }
}

/**
 * "CLE to win, 77%, model 74%, open until the final buzzer" (spec 2.6, R5): the subject first,
 * as the dial's caption says it ("Final, CLE lost, result pending" once the game is over). A
 * result or a void game has no live number to read.
 */
export function dialLabel(i: DialLabelInput): string {
  const caption = dialCaption(i.state, i.game, i.outcome).replaceAll(' · ', ', ')
  const parts = caption ? [caption] : []
  if (i.state !== 'resolved' && i.state !== 'void') {
    parts.push(i.price === null ? 'no price yet' : percent(i.price))
  }
  if (i.modelProb !== null) parts.push(`model ${percent(i.modelProb)}`)
  parts.push(stateWords(i, caption.endsWith('result pending')))
  return parts.join(', ')
}
