// My Game-day's words (R7), pure so they are tested. The night chip sits in the header, so this
// file is on the first load of every page: it imports no SDK entry with a value, only types.
import type { Game, MeGame, MePosition, MeResponse } from '@horagon/sdk'
import { finalWords, homeWonOnScore, resolutionStatus, toWin } from './chrono/copy'
import { type DialState, deriveDialState } from './chrono/state'
import { etClock, etDayLabel } from './chrono/time'
import { countdown, percent, usdc } from './format'

/** The nights a fan aims at; a test pins it to the SDK's NIGHTS_TARGET. */
export const NIGHTS_TARGET = 3

/** Nights, never a streak (a night with no game cannot break it): null at 0. */
export function streakLabel(nights: number): string | null {
  if (nights <= 0) return null
  return nights <= NIGHTS_TARGET ? `Night ${nights} of ${NIGHTS_TARGET}` : `Night ${nights}`
}

/** The chip's spoken label. */
export const chipLabel = (nights: number): string =>
  `You made calls on ${nights} NBA ${nights === 1 ? 'night' : 'nights'}. No value, no prizes.`

/** "+38", "-62", "0". */
export const pointsText = (points: number): string => (points > 0 ? `+${points}` : String(points))

export function headline(vs: MeResponse['vsModel']): string {
  return vs.points === null
    ? 'You vs the model: no result yet tonight'
    : `You vs the model: ${pointsText(vs.points)} tonight`
}

export const SCORE_RULE =
  "Each call scores its result (100 if your team won, 0 if not) minus the model's % for that team when you called it. The model expects 0. No value, no prizes."

export const PRACTICE_NOTE = 'Practice calls are scored apart and never count toward your nights.'

export const KEYS_NOTE =
  'This play wallet lives in this browser only. Another browser or phone shows a different wallet. Export the key to keep it; import it to use it elsewhere.'

/** "Tonight · Fri, Nov 27": the night's own ET date, so after midnight it still names the night. */
export const nightLabel = (night: string): string =>
  `Tonight · ${etDayLabel(Date.parse(`${night}T12:00:00Z`) / 1000)}`

/** "MEM · 38.72 shares · in at 55% · now 62%". */
export function positionLine(p: MePosition): string {
  const price = (v: number | null) => (v === null ? '—' : percent(v))
  return `${p.team} · ${usdc(p.shares)} shares · in at ${price(p.avgPrice)} · now ${price(p.price)}`
}

const payout = (amount: string): string => (Number(amount) === 0 ? '0' : `${usdc(amount)} mUSDC`)
const net = (amount: string): string =>
  amount.startsWith('-') ? usdc(amount) : Number(amount) === 0 ? '0.00' : `+${usdc(amount)}`

/** One side of the if-wins line: "If MEM wins: 38.72 mUSDC", its net "+18.72", and a loss flag. */
export interface IfWinsPart {
  lead: string
  net: string
  /** The net is below zero: the P&L role's red (components/positions.tsx). */
  loss: boolean
}

/** The if-wins line in parts, so the page colours each net by the P&L role; null once settled. */
export function ifWinsParts(e: MeGame): IfWinsPart[] | null {
  if (!e.ifHomeWins || !e.ifAwayWins) return null
  const side = (team: string, w: NonNullable<MeGame['ifHomeWins']>): IfWinsPart => ({
    lead: `If ${team} wins: ${payout(w.payoutUsdc)}`,
    net: net(w.netUsdc),
    loss: w.netUsdc.startsWith('-'),
  })
  return [side(e.game.home, e.ifHomeWins), side(e.game.away, e.ifAwayWins)]
}

/** "If MEM wins: 38.72 mUSDC (+18.72) · If LAC wins: 0 (-20.00)"; null once settled. */
export function ifWinsLine(e: MeGame): string | null {
  const parts = ifWinsParts(e)
  return parts ? parts.map((x) => `${x.lead} (${x.net})`).join(' · ') : null
}

/** Money's colour, the P&L role of components/positions.tsx: lume, or red below zero. */
export const pnlClass = (loss: boolean): string => (loss ? 'text-red-400' : 'text-lume-300')

/** A team code `GET /me` takes (packages/api/src/me.ts `MeQuerySchema`). */
const TEAM_CODE = /^[A-Z]{2,5}$/
/** The most team codes `GET /me` takes. */
export const ME_TEAMS_MAX = 30

/**
 * The followed teams sent to `GET /me`: only codes it takes, each once, at most 30, so one odd
 * stored follow (a Practice code, say) never turns the page into a 400.
 */
export function meTeams(follows: readonly string[]): string[] {
  return [...new Set(follows.filter((t) => TEAM_CODE.test(t)))].slice(0, ME_TEAMS_MAX)
}

/** "Called MEM at model 62% · won · +38", "· pending", or "· not scored" for a game not played. */
export function callLine(p: MePosition, g: Pick<Game, 'status'>): string | null {
  const c = p.call
  if (!c) return null
  if (c.model === null) return `Called ${p.team} · no model to score against`
  const head = `Called ${p.team} at model ${percent(c.model)}`
  if (g.status === 'postponed' || g.status === 'canceled') return `${head} · not scored`
  if (c.result === null || c.points === null) return `${head} · pending`
  return `${head} · ${c.result} · ${pointsText(c.points)}`
}

/**
 * The proposed result's line (R6 part B moves it to lib/chrono/copy.ts with this signature): the
 * challenge countdown, then "finalizing" once it ran out, or no time when the window is unknown.
 */
export function proposedLine(challengeEndsAt: number | null, now: number): string {
  if (challengeEndsAt === null) return 'Result proposed'
  if (challengeEndsAt - now <= 0) return 'Challenge window closed · finalizing'
  return `Result proposed · final in ${countdown(challengeEndsAt, now)} unless a guardian challenges`
}

/** Each status in the dial's role colours: RING in components/chrono/dial-look.ts, as text. */
export const STATUS_TEXT: Record<DialState, string> = {
  resolved: 'text-ash-400',
  challenged: 'text-red-400',
  proposed: 'text-brass-500',
  void: 'text-ash-400/40',
  halted: 'text-amber-400',
  closed: 'text-ash-400',
  closing: 'text-amber-400',
  live: 'text-lume-300',
  pre: 'text-ash-400',
}

export interface StatusWords {
  line: string
  /** After a result: "You won · 38.72 mUSDC to claim", "You won · claimed" or "Lost". */
  result: string | null
  /** The money in "You won · 38.72 mUSDC to claim", drawn in the P&L role; null otherwise. */
  claimUsdc: string | null
  state: DialState
}

/**
 * A position's status, from the same dial state the board and the game page draw (so a final
 * game reads closed, and a halt only while the game is on the court reads halted).
 */
export function statusOf(p: MePosition, g: Game, now: number): StatusWords {
  const m = g.markets.find((x) => x.pubkey === p.market)
  const state = deriveDialState(g, m, now)
  const words = (
    line: string,
    result: string | null = null,
    claimUsdc: string | null = null,
  ): StatusWords => ({ line, result, claimUsdc, state })
  switch (state) {
    case 'resolved': {
      const won = (m?.outcome === 'yes') === (p.side === 'home')
      const line = resolutionStatus(state, g, m?.outcome ?? null)
      if (!won) return words(line, 'Lost')
      if (!p.claimable) return words(line, 'You won · claimed')
      const claim = `${usdc(p.valueUsdc)} mUSDC`
      return words(line, `You won · ${claim} to claim`, claim)
    }
    case 'challenged':
      return words('Result under review')
    case 'proposed':
      return words(proposedLine(p.challengeEndsAt, now))
    case 'void':
      return words(resolutionStatus(state, g, null))
    case 'halted':
      return words('Trading halted')
    case 'closed':
      return words(
        g.status === 'final'
          ? `${finalWords(g, homeWonOnScore(g))} · result pending`
          : 'Trading closed',
      )
    default:
      return words(
        m
          ? `Open until the final buzzer · latest ${etClock(m.endTs)}`
          : 'Open until the final buzzer',
      )
  }
}

/** "MEM to win · 62%" from the market price, while it trades. */
export const priceLine = (g: Game, price: number | null): string => toWin(g.home, price)

/** "Sat, Nov 28 · 7:30 PM ET · LAC @ MEM". */
export function nextRow(g: Pick<Game, 'home' | 'away' | 'scheduledTipoff'>): string {
  const tip = Date.parse(g.scheduledTipoff) / 1000
  return `${etDayLabel(tip)} · ${etClock(tip)} · ${g.away} @ ${g.home}`
}
