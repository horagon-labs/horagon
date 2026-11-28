// The first screen's state and layout (first-screen spec §3), picked on the server from the first
// frame's data. `firstScreen` is the page's one layout decision: whether the idle face takes the
// dial's slot and what fills it (the story card, or the R10 strip when /nights misses), or the
// Night dial keeps it with the compact story under the board; which night the story tells; and
// whether a Practice run leads the face. app/page.tsx only renders it. The page hands the state to
// the board, which re-checks on every poll whether that face still fits, by the same `marketOpen`
// and `nightOver` (lib/chrono/board.ts faceGone).
import type { Game, Night, NightGame, PracticeResponse } from '@horagon/sdk'
import { boardItem, marketOpen, movedFromOpen, nightOver } from '../chrono/board'
import { practiceLive } from '../chrono/practice'
import { isTonight } from '../format'
import { currentNight, type LastNight } from './last-night'

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
const idleState = (s: ScreenState): boolean => s === 'rest' || s === 'later' || s === 'after'

/**
 * The night the story tells (§3 S5, §6): in S5 the night that just ended, from the board's own
 * games (`currentNight`); otherwise, or when none of tonight's games is a final NBA game with a
 * winner market, `lastNight` (R10's newest final night before tonight's). Null with neither. The
 * page loads the story for this night's date.
 */
export function storyNight(
  games: readonly Game[] | undefined,
  now: number,
  lastNight: LastNight | null,
): LastNight | null {
  return (screenState(games, now) === 'after' && currentNight(games ?? [], now)) || lastNight
}

export interface FirstScreenData {
  /** The board's first frame (undefined: the API did not answer in time) and its clock. */
  games: readonly Game[] | undefined
  now: number
  /** R10's newest final night before tonight's, or null. */
  lastNight: LastNight | null
  /** The story `initialStory` found for `storyNight`'s date; null on a /nights miss. */
  story: { night: Night; game: NightGame } | null
  /** GET /practice (R8); null with FLAG_PRACTICE off or no answer. */
  practice: PracticeResponse | null
}

/** How `/` lays out its first frame (§3); app/page.tsx renders exactly this. */
export interface FirstScreen {
  state: ScreenState
  /** The night the story tells (`storyNight`), or null when there is none to tell. */
  night: LastNight | null
  /**
   * The idle face and its foot take the dial's slot: S1, S2 or S5 with a night to tell. Otherwise
   * the Night dial keeps it (S3, S4, or no night) and the compact story follows the board.
   */
  idle: boolean
  /** What fills the idle face: the story card, the R10 strip on a /nights miss; null when not idle. */
  face: 'story' | 'strip' | null
  /** The Practice run that leads the idle face (S6): live, or scheduled and past its tip-off. */
  lead: Game | null
  /**
   * A run leads the face, so the face's story card is compact below lg (full from lg), and the
   * foot leaves the run's own line to the card.
   */
  compact: boolean
}

export function firstScreen(d: FirstScreenData): FirstScreen {
  const state = screenState(d.games, d.now)
  const night = storyNight(d.games, d.now, d.lastNight)
  const idle = idleState(state) && night !== null
  const lead = idle ? practiceLive(d.practice, d.now) : null
  return {
    state,
    night,
    idle,
    face: !idle ? null : d.story ? 'story' : 'strip',
    lead,
    compact: lead !== null,
  }
}

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
