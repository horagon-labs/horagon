// What the keeper reads from a score feed, independent of the provider. Live ESPN and the
// replay of a recorded game both produce this shape.
export type FeedStatus = 'scheduled' | 'live' | 'final' | 'postponed' | 'canceled'

/** The leagues a feed reports: the NBA, and the Practice process's replays (R8). */
export type League = 'NBA' | 'PRACTICE'

export interface FeedGame {
  league: League
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
  /** Seconds left in the current period; null unless live. */
  clockSecs: number | null
  homeScore: number
  awayScore: number
  /** [home, away] points per period, overtime included. */
  periods: Array<[number, number]>
  /** NBA Cup game (featured first, spec 6.3). */
  cup: boolean
  /**
   * The public page of this game's data, when the feed has one per game (a Practice recording,
   * R8): a draft cites it instead of the snapshot's URL.
   */
  sourceUrl?: string
}

export interface FeedSnapshot {
  source: string
  url: string
  fetchedAt: Date
  games: FeedGame[]
  /**
   * Events the feed answered but could not read (format change, bad score). Keeper.tick (Task 19) alerts
   * when this is above 0, so a silent ESPN change cannot make games disappear.
   */
  skipped?: number
}

export interface Feed {
  readonly name: string
  /** Every game of one league date (US Eastern YYYY-MM-DD). */
  fetchDay(gameDate: string): Promise<FeedSnapshot>
}

/** `nba-<externalId>` (or `practice-<externalId>`), the id used by the DB, API and evidence. */
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

/** The league's calendar date (US Eastern, YYYY-MM-DD) of an instant. */
export const easternDate = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d)
