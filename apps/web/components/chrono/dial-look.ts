// How each DialState colors a dial (spec 4.3): the time ring, and the face's rim.
import type { Game, GameHistory } from '@horagon/sdk'
import type { Run } from '../../lib/chrono/runs'
import type { DialState } from '../../lib/chrono/state'
import { cents, countdown, gameClock } from '../../lib/format'

/** The time ring: lume while live, amber near the close or halted, ash otherwise. */
export const RING: Record<DialState, string> = {
  resolved: 'stroke-ash-400',
  challenged: 'stroke-red-400',
  proposed: 'stroke-brass-500',
  void: 'stroke-ash-400/40',
  halted: 'stroke-amber-400',
  closed: 'stroke-ash-400',
  closing: 'stroke-amber-400',
  live: 'stroke-lume-300',
  pre: 'stroke-ash-400',
}

/** The rim: red while the result is under review, the plain line otherwise. */
export const rimClass = (state: DialState): string =>
  state === 'challenged' ? 'stroke-red-400' : 'stroke-line'

/** The needle's color: lume while it can move, ash before tip-off and once trading stopped. */
export const needleClass = (state: DialState): string =>
  state === 'live' || state === 'closing' ? 'stroke-lume-300' : 'stroke-ash-400'

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
      return 'Trading closed, waiting for the result'
    case 'closing':
      return `closes in ${countdown(secsLeft ?? 0, 0)}`
    case 'live':
      return 'Open until the final buzzer'
    case 'pre': {
      if (secsLeft === null) return 'market opens 60 min before tip-off'
      const tip = Math.floor(Date.parse(game.scheduledTipoff) / 1000)
      return tip > nowSecs ? `tip-off in ${countdown(tip, nowSecs)}` : 'tip-off soon'
    }
  }
}
