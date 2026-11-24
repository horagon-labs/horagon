// How each DialState colors a dial (spec 4.3): the time ring, and the face's rim.
import type { Game } from '@horagon/sdk'
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

type LineGame = Pick<Game, 'status' | 'period' | 'clockSecs' | 'scheduledTipoff'>

/** The one line under the number (spec 4.3 "Cách hien"); void reuses gameClock's own words. */
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
    case 'live':
      return `closes in ${countdown(secsLeft ?? 0, 0)}`
    case 'pre': {
      if (secsLeft === null) return 'market opens 60 min before tip-off'
      const tip = Math.floor(Date.parse(game.scheduledTipoff) / 1000)
      return tip > nowSecs ? `tip-off in ${countdown(tip, nowSecs)}` : 'tip-off soon'
    }
  }
}
