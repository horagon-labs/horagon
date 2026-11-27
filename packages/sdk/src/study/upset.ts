// The public upset rule: the winner opened at 33% or less. The opening price is the model's
// pre-game % written on chain when the market opens (`initialPriceBps`, YES = the home team).

/** The highest winner opening, in basis points, that still counts as an upset. */
export const UPSET_MAX_BPS = 3_300

/** The winner's opening price in basis points: YES (home) as stored, or its complement. */
export function winnerOpened(initialPriceBps: number, homeWon: boolean): number {
  return homeWon ? initialPriceBps : 10_000 - initialPriceBps
}

/** True when the winner opened at 33% or less. */
export function isUpset(initialPriceBps: number, homeWon: boolean): boolean {
  return winnerOpened(initialPriceBps, homeWon) <= UPSET_MAX_BPS
}
