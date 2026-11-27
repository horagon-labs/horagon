// The Practice card's moving words (first-screen W8b): the score line and the price, read by the
// card's 15 s text island. Apart from lib/chrono/practice.ts, so the island ships these two reads
// and not every Practice string to the browser.
import type { Game } from '@horagon/sdk'
import { gameClock, percent } from '../format'

/**
 * The card's score line: "MEM 78–84 CLE · Q3 4:12" while the replay is on, "… · Final" once over
 * (W8b). Null before the feed has the game on.
 */
export function practiceScore(g: Game): string | null {
  if (g.status !== 'live' && g.status !== 'final') return null
  return `${g.away} ${g.awayScore}–${g.homeScore} ${g.home} · ${gameClock(g)}`
}

/**
 * The card's price: "CLE to win" and "62%" (the home side, as the replay's game page says it)
 * while the game is on and its winner market trades with a price. Null otherwise: no stale price.
 */
export function practicePrice(g: Game): { subject: string; value: string } | null {
  const m = g.markets.find((x) => x.kind === 'winner')
  if (g.status === 'final' || !m || m.status !== 'open' || m.price === null) return null
  return { subject: `${g.home} to win`, value: percent(m.price) }
}
