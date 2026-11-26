// What a price means, in words (R5, audit section 13). The number on every dial and row is the
// home side's chance to win: it reads "MEM to win · 62%", never a bare "62¢". Once the game is
// over the words follow the scoreboard, then the result on-chain: "Final · CHA lost · result
// pending", then "Resolved: MEM won". A losing side is never shown as "wins".
import type { Game, MarketStatus, Outcome } from '@horagon/sdk'
import { percent } from '../format'
import type { DialState } from './state'

export type VerdictGame = Pick<Game, 'home' | 'away' | 'status' | 'homeScore' | 'awayScore'>

/** What the dial's number stands for right now. */
export type Verdict =
  /** Before and during the game: the home side's chance to win. */
  | { kind: 'to-win' }
  /** The final buzzer went, the result is not on-chain yet; `homeWon` from the scoreboard. */
  | { kind: 'final'; homeWon: boolean | null }
  /** The market resolved: `homeWon` from its outcome (YES is the home side). */
  | { kind: 'resolved'; homeWon: boolean }
  /** Postponed or canceled, nothing resolved. */
  | { kind: 'void' }

/** The home side won on the scoreboard; null before the end (and for a tie, which never ends one). */
export function homeWonOnScore(g: VerdictGame): boolean | null {
  if (g.status !== 'final' || g.homeScore === g.awayScore) return null
  return g.homeScore > g.awayScore
}

export function verdict(state: DialState, g: VerdictGame, outcome: Outcome | null): Verdict {
  if (state === 'resolved' && outcome) return { kind: 'resolved', homeWon: outcome === 'yes' }
  if (state === 'void') return { kind: 'void' }
  if (g.status === 'final') return { kind: 'final', homeWon: homeWonOnScore(g) }
  return { kind: 'to-win' }
}

/** "Resolved: MEM won"; a result that is not a final (a game postponed for good) names no winner. */
function resolvedWords(g: VerdictGame, homeWon: boolean): string {
  if (g.status !== 'final') return `Resolved: ${g.home} ${homeWon ? 'won' : 'did not win'}`
  return `Resolved: ${homeWon ? g.home : g.away} won`
}

/** "Final · CHA lost", or "Final" while the scoreboard names no winner. */
export function finalWords(g: VerdictGame, homeWon: boolean | null): string {
  return homeWon === null ? 'Final' : `Final · ${g.home} ${homeWon ? 'won' : 'lost'}`
}

/** The keeper never opened a market for a game that has started (R5c, review finding 5). */
export const NO_MARKET = 'No market for this game'

/** The game is on the court or over: a missing market will not open any more. */
export const started = (g: Pick<Game, 'status'>): boolean => g.status !== 'scheduled'

/**
 * The line under the dial's number: "MEM to win", "Final · CHA lost · result pending",
 * "Resolved: MEM won", or nothing for a void game (its own line says postponed or canceled).
 * A final game with no market (`pre`, the only state a final game without one has) has no result
 * to wait for: "Final · CHA lost".
 */
export function dialCaption(state: DialState, g: VerdictGame, outcome: Outcome | null): string {
  const v = verdict(state, g, outcome)
  switch (v.kind) {
    case 'resolved':
      return resolvedWords(g, v.homeWon)
    case 'final':
      return state === 'pre'
        ? finalWords(g, v.homeWon)
        : `${finalWords(g, v.homeWon)} · result pending`
    case 'void':
      return ''
    case 'to-win':
      return `${g.home} to win`
  }
}

/**
 * A position's market status in the wallet sheet (R5c, review finding 2): the keeper's halt is
 * the normal close at the final buzzer, so `halted` reads "trading closed". A Position carries no
 * game status to tell that from a halt mid-game; the game page says which one it was.
 */
export const positionStatus = (status: MarketStatus): string =>
  status === 'halted' ? 'trading closed' : status

/** The ResolutionCard's link to the halt transaction: at the final buzzer it is the close. */
export const haltLinkLabel = (g: Pick<Game, 'status'>): string =>
  g.status === 'final' ? 'Closed' : 'Halted'

/** The short subject over a row's number: "MEM to win", "CHA lost", "Resolved: MEM won". */
export function rowSubject(state: DialState, g: VerdictGame, outcome: Outcome | null): string {
  const v = verdict(state, g, outcome)
  switch (v.kind) {
    case 'resolved':
      return resolvedWords(g, v.homeWon)
    case 'final':
      return v.homeWon === null ? 'Final' : `${g.home} ${v.homeWon ? 'won' : 'lost'}`
    case 'void':
      return ''
    case 'to-win':
      return `${g.home} to win`
  }
}

/** "MEM to win · 62%", or "MEM to win" while there is no price. */
export function toWin(team: string, price: number | null): string {
  return price === null ? `${team} to win` : `${team} to win · ${percent(price)}`
}

/** The number is still a live chance: lit while it trades, ash once trading stopped. */
export const liveNumber = (state: DialState): boolean =>
  state === 'live' || state === 'closing' || state === 'pre' || state === 'halted'

/** The Model line's explanation, in place (audit section 4). */
export const MODEL_HINT = 'Model: live win chance from score and clock'

/** Why nothing trades once the game is final, open market or halted (R1, R5c). */
export const BUZZER_CLOSED = 'Trading closed at the final buzzer.'

/** After the close, before a result: who checks, and what comes next. */
const RESULT_NEXT = 'The result goes on-chain after a box-score check.'
export const CLOSED_LINE = `Trading closed. ${RESULT_NEXT}`

type StatusGame = VerdictGame & Pick<Game, 'status'>

/**
 * The ResolutionCard's status, from the dial's state rather than the raw chain status, so it
 * never says "open" next to a dial that says trading closed (audit finding 11).
 */
export function resolutionStatus(state: DialState, g: StatusGame, outcome: Outcome | null): string {
  switch (state) {
    case 'resolved':
      return outcome ? resolvedWords(g, outcome === 'yes') : 'Result final'
    case 'challenged':
      return 'Result under review'
    case 'proposed':
      return 'Result proposed: the challenge window is open'
    case 'void':
      return g.status === 'canceled' ? 'Game canceled' : 'Game postponed'
    case 'halted':
      return 'Trading halted'
    case 'closed':
      return g.status === 'final'
        ? `Final ${g.away} ${g.awayScore}–${g.homeScore} ${g.home}. ${RESULT_NEXT}`
        : CLOSED_LINE
    default:
      return 'Trading open'
  }
}
