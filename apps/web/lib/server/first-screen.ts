// The first screen's state (first-screen spec §3), picked on the server from the board's first
// frame. The board re-checks the part that matters to the browser (a market open or not) on every
// poll; the page uses this to lay out the idle face, or the compact story under the Night dial.
import type { Game } from '@horagon/sdk'
import { boardItem, nightOver, openNow } from '../chrono/board'
import { isTonight } from '../format'

/**
 * S1 rest (the 24 h list is empty), S2 later (listed, nothing open), S3 pre-open (a market open,
 * no game on the court), S4 live, S5 after (every game of the night stopped).
 */
export type ScreenState = 'rest' | 'later' | 'preopen' | 'live' | 'after'

export function screenState(games: readonly Game[] | undefined, now: number): ScreenState {
  // No first frame: the board loads in the browser, with no market known to be open.
  if (games === undefined) return 'later'
  const listed = games.filter((g) => isTonight(g, now * 1000))
  if (listed.some((g) => openNow(boardItem(g, undefined, now)))) {
    return listed.some((g) => g.status === 'live') ? 'live' : 'preopen'
  }
  if (nightOver(games, now)) return 'after'
  return listed.length > 0 ? 'later' : 'rest'
}

/** The idle face (story card) takes the dial slot in S1, S2 and S5 (§3). */
export const idleState = (s: ScreenState): boolean => s === 'rest' || s === 'later' || s === 'after'
