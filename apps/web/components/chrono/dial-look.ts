// How each DialState colors a dial (spec 4.3): the time ring, and the face's rim.
import type { Game, GameHistory } from '@horagon/sdk'
import { NO_MARKET, started } from '../../lib/chrono/copy'
import type { Run } from '../../lib/chrono/runs'
import { type DialState, isTrading } from '../../lib/chrono/state'
import { cents, countdown, gameClock } from '../../lib/format'

/**
 * The time ring (light branding review §4.2): live while the market is open, closing included
 * (width, the blinking ticks and "closes in" tell it apart); ink and hatched while halted; muted
 * once trading stopped. `pre` here is the face with no market; one with a market reads live
 * through `ringClass`.
 */
export const RING: Record<DialState, string> = {
  resolved: 'stroke-ash-400',
  challenged: 'stroke-red-400',
  proposed: 'stroke-ash-400',
  void: 'stroke-line',
  halted: 'stroke-amber-400',
  closed: 'stroke-ash-400',
  closing: 'stroke-live',
  live: 'stroke-live',
  pre: 'stroke-ash-400',
}

/** States whose ring is a status, drawn whole, not the time left (light branding review §4.2). */
const STATUS_RING: readonly DialState[] = ['halted', 'proposed', 'challenged']

/**
 * How much of the time ring is drawn: the time left, except for a status no time left describes:
 * a halt while the game is still on the court (`halted`; a final game reads `closed`), the ink
 * hatched ring of spec 4.3, so a halt never looks like a normal close; a proposed result (dotted)
 * and one under review (error), so the face says where the result stands (review §4.2).
 */
export const ringShare = (state: DialState, timeLeft: number): number =>
  STATUS_RING.includes(state) ? 1 : timeLeft

/** The ring's dash: a halt hatched `3 3`, a proposed result dotted `1.5 3` (review §4.2). */
export const ringDash = (state: DialState): string | undefined =>
  state === 'halted' ? '3 3' : state === 'proposed' ? '1.5 3' : undefined

/** The case: brass, 1.5; while the result is under review a 2 px error rim takes its place. */
export const rimClass = (state: DialState): string =>
  state === 'challenged' ? 'stroke-red-400' : 'stroke-brass-700'

/** The case's width: 1.5 for brass, 2 for the error rim that replaces it (review §4.2). */
export const rimWidth = (state: DialState): number => (state === 'challenged' ? 2 : 1.5)

/**
 * The ring's color on a face: `open` is "this face has a price", and a market opens 60 min before
 * tip-off (the keeper creates it then), so `pre` with a price is an open market and reads live;
 * `pre` with none waits, muted (review §3.2). Every other state reads its RING entry.
 */
export const ringClass = (state: DialState, open: boolean): string =>
  state === 'pre' ? (open ? 'stroke-live' : 'stroke-ash-400') : RING[state]

/**
 * The needle's color: live while the market trades, before tip-off too (a `pre` needle is drawn
 * only with a market, `needlePrice`), muted once trading stopped.
 */
export const needleClass = (state: DialState): string =>
  isTrading(state) ? 'stroke-live' : 'stroke-ash-400'

/** The big number: whole cents with honest edges, or an em dash for no price, never NaN. */
export const priceDigits = (price: number | null): string =>
  price === null || !Number.isFinite(price) ? '—' : cents(price).replace('¢', '')

/**
 * A beat (the run flash or the settle) plays only for a new, non-null key on a dial that
 * already had data at the previous key: never on page load, on the first fetch, or when a run
 * ends (spec 2.4).
 */
export function isBeat(
  prev: { key: string | null | undefined; armed: boolean },
  key: string | null | undefined,
): boolean {
  return prev.armed && key !== prev.key && key != null
}

/**
 * The run flash's key: `undefined` until history has loaded (not known yet), `null` for history
 * with no run, otherwise the newest run's streak, by its first basket: it stays the same while
 * the run grows (8–0, 10–0, 12–0), so the rim flashes once per run (spec 2.4). The dial absorbs
 * the first key (see `beatArmed`).
 */
export const runKeyOf = (
  history: GameHistory | undefined,
  run: Run | null,
): string | null | undefined => (history ? (run ? `${run.team}:${run.start}` : null) : undefined)

/** The flash is armed once the dial has loaded and its key is known. */
export const beatArmed = (loading: boolean | undefined, key: string | null | undefined): boolean =>
  !loading && key !== undefined

type LineGame = Pick<Game, 'status' | 'period' | 'clockSecs' | 'scheduledTipoff'>

/**
 * The one line under the number (spec 4.3 "Cách hien"); void reuses gameClock's own words. An
 * open market closes at the final buzzer (the keeper halts it on the first Final), so a live
 * one names no time; in its last 5 min before end_ts it closes at end_ts, and counts down.
 */
export function stateLine(
  state: DialState,
  game: LineGame,
  secsLeft: number | null,
  nowSecs: number,
): string {
  switch (state) {
    case 'resolved':
      return 'Result final'
    case 'challenged':
      return 'Result under review'
    case 'proposed':
      return 'Result proposed'
    case 'void':
      return gameClock(game)
    case 'halted':
      return 'Trading halted'
    case 'closed':
      return 'Trading closed · result pending'
    case 'closing':
      return `closes in ${countdown(secsLeft ?? 0, 0)}`
    case 'live':
      return 'Open until the final buzzer'
    case 'pre': {
      // No market: one opens 60 min before tip-off, so a game already started will not get one.
      if (secsLeft === null) return started(game) ? NO_MARKET : 'Opens 60 min before tip-off'
      const tip = Math.floor(Date.parse(game.scheduledTipoff) / 1000)
      return tip > nowSecs ? `tip-off in ${countdown(tip, nowSecs)}` : 'tip-off soon'
    }
  }
}
