// The one place that decides how a dial looks (spec 4.3): `deriveDialState` checks the rows of
// the table in order and the first match wins. Every "now" is chain-adjusted (spec 5.4).
import {
  effectiveTime,
  type Game,
  type MarketSummary,
  type Outcome,
  parseResolutionEvidence,
} from '@horagon/sdk'
import { cents, percent } from '../format'
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

type GameFields = Pick<Game, 'status'>
type MarketFields = Pick<MarketSummary, 'status' | 'endTs' | 'priceTs'>

/**
 * Rows 1-3 (a result on the market) come before row 4 (a void game) on purpose: a game
 * postponed for more than 7 days resolves NO (the keeper's postponedResolveSecs), and whoever
 * holds the winning side must still see Claim all.
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
  if (market.status === 'halted') return 'halted'
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

/** The outcome a proposal's evidence JSON names, or null when it cannot be read. */
export function proposedOutcome(json: string): Outcome | null {
  try {
    return parseResolutionEvidence(JSON.parse(json)).outcome
  } catch {
    return null
  }
}

export interface DialLabelInput {
  /** The home team: the needle is its price (YES). */
  team: string
  price: number | null
  modelProb: number | null
  state: DialState
  /** Seconds until trading closes; null without a market. */
  secsLeft: number | null
  gameStatus: Game['status']
}

function stateWords(i: DialLabelInput): string {
  switch (i.state) {
    case 'resolved':
      return 'result final'
    case 'challenged':
      return 'result under review'
    case 'proposed':
      return 'result proposed'
    case 'void':
      return `game ${i.gameStatus}`
    case 'halted':
      return 'trading halted'
    case 'closed':
      return 'trading closed, waiting for the result'
    default:
      return i.secsLeft === null
        ? 'market opens 60 min before tip-off'
        : `closes in ${spokenDuration(i.secsLeft)}`
  }
}

/** "CLE wins, 77 cents, model 74, closes in 1 hour 2 minutes" (spec 2.6). */
export function dialLabel(i: DialLabelInput): string {
  const parts = [
    `${i.team} wins`,
    i.price === null ? 'no price yet' : cents(i.price).replace('¢', ' cents'),
  ]
  if (i.modelProb !== null) parts.push(`model ${percent(i.modelProb).replace('%', '')}`)
  parts.push(stateWords(i))
  return parts.join(', ')
}
