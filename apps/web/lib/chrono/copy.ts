// What a price means, in words (R5, audit section 13). The number on every dial and row is the
// home side's chance to win: it reads "MEM to win · 62%", never a bare number. Once the game is
// over the words follow the scoreboard, then the result on-chain: "Final · CHA lost · result
// pending", then "Resolved: MEM won". A losing side is never shown as "wins".
import type { Game, MarketStatus, Outcome } from '@horagon/sdk'
import { countdown, percent } from '../format'
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

/**
 * The ResolutionCard's result (culture review string 20): "Result on-chain · MEM won"; its link
 * to /verify sits under it ("Verify this result").
 */
function onChainWords(g: VerdictGame, homeWon: boolean): string {
  if (g.status !== 'final') return `Result on-chain · ${g.home} ${homeWon ? 'won' : 'did not win'}`
  return `Result on-chain · ${homeWon ? g.home : g.away} won`
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
 * to wait for: "Final · CHA lost". Neither does a result that is proposed or under review (R5c
 * refix): the state line under it says so, never next to "result pending".
 */
export function dialCaption(state: DialState, g: VerdictGame, outcome: Outcome | null): string {
  const v = verdict(state, g, outcome)
  switch (v.kind) {
    case 'resolved':
      return resolvedWords(g, v.homeWon)
    case 'final':
      return state === 'pre' || state === 'proposed' || state === 'challenged'
        ? finalWords(g, v.homeWon)
        : `${finalWords(g, v.homeWon)} · result pending`
    case 'void':
      return ''
    case 'to-win':
      return `${g.home} to win`
  }
}

/**
 * The caption on the dial face: dialCaption without "result pending", which the state line under
 * it already says ("Trading closed · result pending"), so the caption holds one line at 375 px.
 */
export function faceCaption(state: DialState, g: VerdictGame, outcome: Outcome | null): string {
  const v = verdict(state, g, outcome)
  return v.kind === 'final' ? finalWords(g, v.homeWon) : dialCaption(state, g, outcome)
}

/**
 * A position's market status in the wallet sheet (R5c, review finding 2): the keeper's halt is
 * the normal close at the final buzzer, so `halted` reads "trading closed". A Position carries no
 * game status to tell that from a halt mid-game; the game page says which one it was. An `open`
 * market says nothing (null, R5c refix): in the seconds between the final buzzer and the halt
 * reaching the index it is no longer open, and the sheet cannot tell.
 */
export const positionStatus = (status: MarketStatus): string | null =>
  status === 'open' ? null : status === 'halted' ? 'trading closed' : status

/**
 * The ResolutionCard's note when someone besides Horagon provides liquidity: the keeper's halt
 * withdraws only Horagon's share, so the market can still trade on chain. On a final game that
 * halt is the close at the final buzzer (R5c refix), so the note never says "halt" under a dial
 * that says trading closed.
 */
export function externalLpNote(g: Pick<Game, 'status'>): string {
  const who = 'Someone besides Horagon also provides liquidity here.'
  return g.status === 'final'
    ? `${who} The close at the final buzzer withdraws only Horagon's share, so this market can still trade outside Horagon.`
    : `${who} A halt withdraws only Horagon's share, so this market can still trade after a halt.`
}

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

/**
 * The dial's legend (culture review string 23): the two words a fan learns, "the needle" and
 * "the model". The needle is the market price, never "the crowd": the reference agent drives most
 * of its moves at this size.
 */
export const DIAL_LEGEND = '● Needle: the market price · ▲ Model: win chance from score and clock'

/** Why nothing trades once the game is final, open market or halted (R1, R5c). */
export const BUZZER_CLOSED = 'Trading closed at the final buzzer.'

/** Where a game's close is read from: its tip-off and its markets (the winner market first). */
export type CloseGame = Partial<Pick<Game, 'scheduledTipoff' | 'markets'>>

/**
 * How long after tip-off the game's market ends, from that market's own end_ts: "3 h",
 * "2 h 10 min", "30 min", to the minute. Null without a market. Never a constant: the markets of
 * ET 2026-11-24 and 11-25 ended 2 h 10 min after tip-off, today's 3 h, a Practice run's 30 min.
 */
export function endAfterTip(g: CloseGame): string | null {
  const m = g.markets?.find((x) => x.kind === 'winner') ?? g.markets?.[0]
  if (!m || !g.scheduledTipoff) return null
  return spanAfterTip(m.endTs - Date.parse(g.scheduledTipoff) / 1000)
}

/** Seconds from tip-off to an end_ts, to the minute: "3 h", "2 h 10 min", "30 min". */
export function spanAfterTip(secs: number): string {
  const mins = Math.max(0, Math.round(secs / 60))
  const h = Math.floor(mins / 60)
  const rest = mins % 60
  if (h === 0) return `${rest} min`
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`
}

/**
 * After the close, before a result: what comes next (R6). A result can be proposed only from the
 * market's end_ts on (the program's rule), so this names that time and promises nothing sooner,
 * nor who sends it. The challenge window is the Config's setting, which the admin can change:
 * no fixed length here.
 */
export function resultNext(g: CloseGame): string {
  const after = endAfterTip(g)
  const from = after ? `${after} after tip-off` : "the market's end time"
  return `The result goes on-chain no earlier than ${from}, then a guardian can challenge it before it is final.`
}

/** The Pusher's line once trading closed with no result yet (R6). */
export const closedLine = (g: CloseGame): string => `Trading closed. ${resultNext(g)}`

type StatusGame = VerdictGame & Pick<Game, 'status'> & CloseGame

/** The window before a proposed result: when the API knows it (`Resolution.challengeEndsAt`). */
const OPEN_WINDOW = 'Result proposed: the challenge window is open'

/**
 * A proposed result's line (R6 part B; R7's /me uses the same words): the challenge countdown,
 * then "finalizing" once it ran out (the keeper finalizes on its next tick), or the open-window
 * words when the end is unknown (the API never guesses the window).
 */
export function proposedLine(challengeEndsAt: number | null, now: number): string {
  if (challengeEndsAt === null) return OPEN_WINDOW
  if (challengeEndsAt - now <= 0) return 'Challenge window closed · finalizing'
  return `Result proposed · final in ${countdown(challengeEndsAt, now)} unless a guardian challenges`
}

/** When a proposed result's window ends, and the clock it is read against. */
export interface WindowTiming {
  challengeEndsAt: number | null
  now: number
}

/**
 * The ResolutionCard's status, from the dial's state rather than the raw chain status, so it
 * never says "open" next to a dial that says trading closed (audit finding 11).
 */
export function resolutionStatus(
  state: DialState,
  g: StatusGame,
  outcome: Outcome | null,
  timing?: WindowTiming,
): string {
  switch (state) {
    case 'resolved':
      return outcome ? onChainWords(g, outcome === 'yes') : 'Result final'
    case 'challenged':
      return 'Result under review'
    case 'proposed':
      return timing ? proposedLine(timing.challengeEndsAt, timing.now) : OPEN_WINDOW
    case 'void':
      return g.status === 'canceled' ? 'Game canceled' : 'Game postponed'
    case 'halted':
      return 'Trading halted'
    case 'closed':
      return g.status === 'final'
        ? `Final ${g.away} ${g.awayScore}–${g.homeScore} ${g.home}. ${resultNext(g)}`
        : closedLine(g)
    default:
      return 'Trading open'
  }
}
