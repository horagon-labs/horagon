// The one place that decides how a dial looks (spec 4.3): `deriveDialState` checks the rows of
// the table in order and the first match wins. Every "now" is chain-adjusted (spec 5.4).
import type { Game, MarketSummary, Outcome } from '@horagon/sdk'
import { effectiveTime } from '@horagon/sdk/math'
import { percent } from '../format'
import { dialCaption, NO_MARKET, started, type Verdict, type VerdictGame, verdict } from './copy'
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

type GameFields = Pick<Game, 'status'> &
  Partial<Pick<Game, 'period' | 'clockSecs' | 'homeScore' | 'awayScore'>>

/** The horn frame (A2, R8): live, period 4 or later, clock 0, scores apart (stop.ts says why). */
const hornFrame = (g: GameFields): boolean =>
  g.status === 'live' &&
  (g.period ?? 0) >= 4 &&
  g.clockSecs === 0 &&
  g.homeScore !== undefined &&
  g.homeScore !== g.awayScore
type MarketFields = Pick<MarketSummary, 'status' | 'endTs' | 'priceTs'>

/**
 * The game trades now or still will: a trading state, except a game that started with no market
 * (R5c refix). That one reads `pre`, the only state without a market, but no market opens once
 * the game has started, so it has no time left, no open arc and no place among the live games.
 */
export const stillTrades = (state: DialState, game: GameFields, hasMarket: boolean): boolean =>
  isTrading(state) && (hasMarket || !started(game))

/**
 * Rows 1-3 (a result on the market) come before row 4 (a void game) on purpose: a game
 * postponed for more than 7 days resolves NO (the keeper's postponedResolveSecs), and whoever
 * holds the winning side must still see Claim all.
 *
 * The final buzzer (R1, R5c): the keeper halts a market on the first Final read, so a market
 * under a final game is closed, with the final caption, whatever its own status says: before
 * end_ts, and also in the seconds before the keeper's halt reaches the index, so the dial never
 * offers a trade on a known result. The keeper also halts on the horn held 10 s (R8): the horn
 * frame is that same close, before its halt lands as after (R8 refix). Only a halt while the
 * game is still on the court is the amber "Trading halted" (row 5).
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
  // Row 10: no market yet; it opens 60 min before tip-off (`started` says when it never did).
  if (!market) return 'pre'
  if (game.status === 'final') return 'closed'
  // The horn frame is the same close, halted or not yet: the keeper holds it 10 s first.
  if (hornFrame(game)) return 'closed'
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

/**
 * The words for the state, after the caption. `kind`: what the caption already said (R5c,
 * review finding 3): after the final buzzer (`final`) it ends with "result pending" for a closed
 * market, so the state words do not say it again.
 */
function stateWords(i: DialLabelInput, kind: Verdict['kind']): string {
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
      return kind === 'final' ? 'trading closed' : 'trading closed, result pending'
    default:
      if (i.secsLeft === null) {
        return started(i.game) ? NO_MARKET.toLowerCase() : 'market opens 60 min before tip-off'
      }
      // An open market closes at the final buzzer; in its last 5 min before end_ts, at end_ts.
      return i.state === 'closing'
        ? `closes in ${spokenDuration(i.secsLeft)}`
        : 'open until the final buzzer'
  }
}

/**
 * The caption as a label says it: "Final, CLE lost, result pending". A result that is proposed
 * or under review is said by the state words: the caption stops at the score then (dialCaption),
 * so a label never says "result pending" next to "result proposed" (R5c).
 */
function spokenCaption(i: Pick<DialLabelInput, 'state' | 'game' | 'outcome'>): {
  words: string
  kind: Verdict['kind']
} {
  const { kind } = verdict(i.state, i.game, i.outcome)
  return { words: dialCaption(i.state, i.game, i.outcome).replaceAll(' · ', ', '), kind }
}

/**
 * "CLE to win, 77%, model 74%, open until the final buzzer" (spec 2.6, R5): the subject first,
 * as the dial's caption says it ("Final, CLE lost, result pending" once the game is over). A
 * result or a void game has no live number to read.
 */
export function dialLabel(i: DialLabelInput): string {
  const caption = spokenCaption(i)
  const parts = caption.words ? [caption.words] : []
  if (i.state !== 'resolved' && i.state !== 'void') {
    parts.push(i.price === null ? 'no price yet' : percent(i.price))
  }
  if (i.modelProb !== null) parts.push(`model ${percent(i.modelProb)}`)
  parts.push(stateWords(i, caption.kind))
  return parts.join(', ')
}

/**
 * The crown dial's spoken sentence (R5c, review finding 4): the same caption as the big dial,
 * so a side that lost is never read "to win", then the price now and after the quoted trade.
 * "CLE to win, 77%, after this trade 79%"; "Final, CLE lost, result pending, 77%".
 */
export function crownLabel(i: {
  state: DialState
  game: VerdictGame
  outcome: Outcome | null
  price: number | null
  /** The price after the quoted trade; null for no quote. */
  ghost: number | null
}): string {
  const caption = spokenCaption(i).words
  const parts = caption ? [caption] : []
  parts.push(i.price === null ? 'no price yet' : percent(i.price))
  if (i.ghost !== null) parts.push(`after this trade ${percent(i.ghost)}`)
  return parts.join(', ')
}
