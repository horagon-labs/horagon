// The second-source check (R6): does balldontlie's final agree with the ESPN draft? Periods are
// not compared, because the winner market (kind 0) reads the totals only.
import type { SecondGame } from './balldontlie'

/**
 * - `match`: balldontlie is final and both totals equal the draft's;
 * - `mismatch`: it is final and either total differs;
 * - `pending`: no game found yet, not final yet, or a final without a total;
 * - `off`: the keeper has no second source (no `BALLDONTLIE_API_KEY`).
 */
export type Verdict = 'match' | 'mismatch' | 'pending' | 'off'

export function verdictOf(
  draft: { homeScore: number; awayScore: number },
  game: SecondGame | null | 'off',
): Verdict {
  if (game === 'off') return 'off'
  if (game === null || game.state !== 'final') return 'pending'
  if (game.homeScore === null || game.awayScore === null) return 'pending'
  return game.homeScore === draft.homeScore && game.awayScore === draft.awayScore
    ? 'match'
    : 'mismatch'
}
