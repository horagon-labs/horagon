// Schedule pass (spec 6.1, "daily 12:00"): the next 36 hours of games with p0 from Elo, and
// up to 4 featured games per league date (NBA Cup first, then the higher Elo sum; spec 6.3).
// It runs hourly, which also picks up postponements and makeup dates; featured is chosen once
// per date, so `horagon-ops featured` overrides stick.
import {
  type Db,
  listGames,
  type ScheduledGame,
  setFeatured,
  upsertScheduledGames,
} from '@horagon/db'
import { applyResults, eloSum, type GameResult, p0For, type Ratings } from './elo'
import type { Feed, FeedGame } from './feeds/types'
import { gameIdOf } from './feeds/types'

export const MAX_FEATURED = 4

/** US Eastern dates covering [now, now + 36 h]. */
export function scheduleDates(nowSecs: number): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
  const dates = new Set<string>()
  for (let h = 0; h <= 36; h += 6) dates.add(fmt.format(new Date((nowSecs + h * 3600) * 1000)))
  return [...dates]
}

export function pickFeatured(games: readonly FeedGame[], ratings: Ratings): string[] {
  return [...games]
    .filter((g) => g.status === 'scheduled')
    .sort(
      (a, b) =>
        Number(b.cup) - Number(a.cup) ||
        eloSum(ratings, b.home, b.away) - eloSum(ratings, a.home, a.away) ||
        a.tipoff.getTime() - b.tipoff.getTime(),
    )
    .slice(0, MAX_FEATURED)
    .map(gameIdOf)
}

const scheduleStatus = (s: FeedGame['status']) =>
  s === 'postponed' || s === 'canceled' ? s : s === 'scheduled' ? 'scheduled' : s

export interface ScheduleDeps {
  db: Db
  feed: Feed
  ratings: Ratings
  now: () => number
}

/** Finals the DB has recorded since the ratings file, applied in order. */
export async function currentRatings(db: Db, base: Ratings, nowSecs: number): Promise<Ratings> {
  const from = new Date(`${base.asOf}T00:00:00Z`)
  const rows = await listGames(db, { from, to: new Date(nowSecs * 1000), statuses: ['final'] })
  const results: GameResult[] = rows.map((g) => ({
    date: g.gameDate,
    home: g.home,
    away: g.away,
    homeScore: g.homeScore,
    awayScore: g.awayScore,
  }))
  return applyResults(base, results)
}

export async function scheduleTick(
  deps: ScheduleDeps,
): Promise<{ upserted: number; featured: string[] }> {
  const now = deps.now()
  const ratings = await currentRatings(deps.db, deps.ratings, now)
  let upserted = 0
  const featured: string[] = []
  for (const date of scheduleDates(now)) {
    const snap = await deps.feed.fetchDay(date)
    const rows: ScheduledGame[] = snap.games.map((g) => ({
      id: gameIdOf(g),
      league: g.league,
      externalId: g.externalId,
      gameDate: g.gameDate,
      home: g.home,
      away: g.away,
      scheduledTipoff: g.tipoff,
      status: scheduleStatus(g.status),
      p0: p0For(ratings, g.home, g.away),
    }))
    await upsertScheduledGames(deps.db, rows)
    upserted += rows.length
    const existing = await listGames(deps.db, {
      from: new Date(`${date}T00:00:00Z`),
      to: new Date(new Date(`${date}T00:00:00Z`).getTime() + 2 * 86_400_000),
    })
    const alreadyChosen = existing.some((g) => g.gameDate === date && g.featured)
    if (!alreadyChosen) {
      const ids = pickFeatured(
        snap.games.filter((g) => g.gameDate === date),
        ratings,
      )
      if (ids.length > 0) {
        await setFeatured(deps.db, date, ids)
        featured.push(...ids)
      }
    }
  }
  return { upserted, featured }
}
