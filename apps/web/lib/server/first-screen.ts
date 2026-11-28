// The first screen's state (first-screen spec §3), picked on the server from the board's first
// frame. The page lays out the idle face by it, or the compact story under the Night dial, and
// hands it to the board, which re-checks on every poll whether that face still fits, by the same
// `marketOpen` and `nightOver` (lib/chrono/board.ts faceGone).
import type { Game, Night } from '@horagon/sdk'
import { boardItem, marketOpen, movedFromOpen, nightOver } from '../chrono/board'
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
  if (marketOpen(games, now)) {
    return listed.some((g) => g.status === 'live') ? 'live' : 'preopen'
  }
  if (nightOver(games, now)) return 'after'
  return listed.length > 0 ? 'later' : 'rest'
}

/** The idle face (story card) takes the dial slot in S1, S2 and S5 (§3). */
export const idleState = (s: ScreenState): boolean => s === 'rest' || s === 'later' || s === 'after'

/**
 * W9: AgentNote ("When nobody trades, a disclosed Horagon agent moves prices toward the model")
 * renders only while that claim shows: the story night had reference-agent calls on any of its
 * games, or a listed market (the 24 h list, open or stopped) moved from its open tonight. A flat
 * night with nothing open, or markets still at their opening prices, gets no note.
 */
export function agentNoteHolds(
  games: readonly Game[] | undefined,
  now: number,
  night: Night | null | undefined,
): boolean {
  if (night?.games.some((g) => g.calls.agent > 0)) return true
  return (games ?? []).some((g) => {
    if (!isTonight(g, now * 1000)) return false
    const m = boardItem(g, undefined, now).market
    return m !== undefined && movedFromOpen(m)
  })
}
