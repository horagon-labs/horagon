// The story plate on a stopped face (culture A2, R8): one word for how the game went. Pure.
// UPSET: the winner opened at 33% or less (the culture plan's upset rule). COMEBACK: the model
// gave the winner 10% or less at some live snapshot. OVERTIME: the game went past Q4. One plate,
// in that order of priority. CLOSEST needs the whole night, so it waits for the night strip.
import type { Game, GameHistory, MarketSummary, Outcome } from '@horagon/sdk'

export type Story = 'Upset' | 'Comeback' | 'Overtime'

export const UPSET_MAX = 0.33
export const COMEBACK_MAX = 0.1

/** Whether the home side won: the market's result, else a final scoreboard; null if unknown. */
export function homeWon(
  g: Pick<Game, 'status' | 'homeScore' | 'awayScore'>,
  outcome: Outcome | null,
): boolean | null {
  if (outcome) return outcome === 'yes'
  if (g.status === 'final' && g.homeScore !== g.awayScore) return g.homeScore > g.awayScore
  return null
}

export function storyOf(
  g: Pick<Game, 'status' | 'homeScore' | 'awayScore' | 'period'>,
  market: Pick<MarketSummary, 'initialPriceBps' | 'outcome'> | undefined,
  history: GameHistory | undefined,
): Story | null {
  const home = homeWon(g, market?.outcome ?? null)
  if (home !== null && market) {
    const open = market.initialPriceBps / 10_000
    if ((home ? open : 1 - open) <= UPSET_MAX) return 'Upset'
  }
  if (home !== null) {
    const low = (history?.snapshots ?? []).some(
      (s) =>
        s.period > 0 &&
        s.modelProb !== null &&
        (home ? s.modelProb : 1 - s.modelProb) <= COMEBACK_MAX,
    )
    if (low) return 'Comeback'
  }
  return g.period >= 5 ? 'Overtime' : null
}
