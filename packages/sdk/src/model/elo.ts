import { HoragonError } from '../errors'
/** NBA-style Elo (spec section 7): K = 20, home advantage 100, carryover 0.75 toward 1505. */
export const ELO_K = 20
export const ELO_HOME_ADVANTAGE = 100
export const ELO_MEAN = 1505
export const ELO_CARRYOVER = 0.75
/** Pre-game probabilities are clamped so a market never opens at a near-certain price. */
export const P0_MIN = 0.05
export const P0_MAX = 0.95

/** Unclamped expected score of the home team. */
export function eloExpected(
  eloHome: number,
  eloAway: number,
  homeAdvantage = ELO_HOME_ADVANTAGE,
): number {
  return 1 / (1 + 10 ** (-(eloHome + homeAdvantage - eloAway) / 400))
}

/** p0: the home team's pre-game win probability, clamped to [0.05, 0.95]. */
export function eloProbability(
  eloHome: number,
  eloAway: number,
  homeAdvantage = ELO_HOME_ADVANTAGE,
): number {
  for (const [name, value] of [
    ['eloHome', eloHome],
    ['eloAway', eloAway],
    ['homeAdvantage', homeAdvantage],
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new HoragonError('INVALID_INPUT', `${name} must be finite, got ${value}`)
    }
  }
  return Math.min(P0_MAX, Math.max(P0_MIN, eloExpected(eloHome, eloAway, homeAdvantage)))
}

/** Ratings after one game. Zero-sum: the home gain equals the away loss. */
export function eloUpdate(
  eloHome: number,
  eloAway: number,
  homeWon: boolean,
  k = ELO_K,
  homeAdvantage = ELO_HOME_ADVANTAGE,
): { home: number; away: number } {
  const delta = k * ((homeWon ? 1 : 0) - eloExpected(eloHome, eloAway, homeAdvantage))
  return { home: eloHome + delta, away: eloAway - delta }
}

/** Start-of-season regression toward the mean. */
export function eloCarryover(elo: number, mean = ELO_MEAN, keep = ELO_CARRYOVER): number {
  return keep * elo + (1 - keep) * mean
}
