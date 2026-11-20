// What the keeper reads from a score feed, independent of the provider. Live ESPN and the
// replay of a recorded game both produce this shape.
export type FeedStatus = 'scheduled' | 'live' | 'final' | 'postponed' | 'canceled'

export interface FeedGame {
  league: 'NBA'
  /** The provider's event id (ESPN event id in Tier 1). */
  externalId: string
  /** The league's date for the game, US Eastern, YYYY-MM-DD. */
  gameDate: string
  /** NBA tricodes. */
  home: string
  away: string
  tipoff: Date
  status: FeedStatus
  period: number
  /** Seconds left in the current period; null before tip-off. */
  clockSecs: number | null
  homeScore: number
  awayScore: number
  /** [home, away] points per period, overtime included. */
  periods: Array<[number, number]>
  /** NBA Cup game (featured first, spec 6.3). */
  cup: boolean
}

export interface FeedSnapshot {
  source: string
  url: string
  fetchedAt: Date
  games: FeedGame[]
}

export interface Feed {
  readonly name: string
  /** Every game of one league date (US Eastern YYYY-MM-DD). */
  fetchDay(gameDate: string): Promise<FeedSnapshot>
}

/** `nba-<externalId>`, the id used by the DB, API and evidence. */
export const gameIdOf = (g: Pick<FeedGame, 'league' | 'externalId'>) =>
  `${g.league.toLowerCase()}-${g.externalId}`

/** Periods that add up to the score, at least four of them: the shape evidence requires. */
export function periodsConsistent(
  f: Pick<FeedGame, 'periods' | 'homeScore' | 'awayScore'>,
): boolean {
  if (f.periods.length < 4) return false
  const home = f.periods.reduce((n, p) => n + p[0], 0)
  const away = f.periods.reduce((n, p) => n + p[1], 0)
  return home === f.homeScore && away === f.awayScore
}
