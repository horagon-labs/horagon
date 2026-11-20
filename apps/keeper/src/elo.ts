// Pre-game Elo (spec 7): K 20, home advantage 100, each new season regressed toward 1505 with
// 0.75 kept. `scripts/elo-build.ts` replays the 2025-26 and 2026-27 results into
// `data/elo.json`; the schedule pass then applies finals the DB has seen since.
import { readFile } from 'node:fs/promises'
import { ELO_MEAN, eloCarryover, eloProbability, eloUpdate } from '@horagon/sdk'
import { z } from 'zod'

export interface GameResult {
  /** US Eastern YYYY-MM-DD. */
  date: string
  home: string
  away: string
  homeScore: number
  awayScore: number
}

export const RatingsSchema = z.object({
  /** Last game date included. */
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Standard deviation of the final home margin last season (the Brownian model's sigma). */
  sigma: z.number().positive(),
  teams: z.record(z.string(), z.number()),
})
export type Ratings = z.infer<typeof RatingsSchema>

/** NBA seasons start in October: a date from August on belongs to the next season's year. */
export const seasonOf = (date: string) => {
  const [y, m] = date.split('-').map(Number)
  return (m ?? 0) >= 8 ? (y ?? 0) + 1 : (y ?? 0)
}

/** Apply results in date order, regressing every team at each season change. */
export function applyResults(start: Ratings, results: readonly GameResult[]): Ratings {
  const teams = { ...start.teams }
  let season = seasonOf(start.asOf)
  let asOf = start.asOf
  const sorted = [...results]
    .filter((r) => r.date > start.asOf)
    .sort((a, b) => a.date.localeCompare(b.date))
  for (const r of sorted) {
    const s = seasonOf(r.date)
    if (s !== season) {
      for (const k of Object.keys(teams)) teams[k] = eloCarryover(teams[k] ?? ELO_MEAN)
      season = s
    }
    if (r.homeScore === r.awayScore) continue
    const next = eloUpdate(
      teams[r.home] ?? ELO_MEAN,
      teams[r.away] ?? ELO_MEAN,
      r.homeScore > r.awayScore,
    )
    teams[r.home] = next.home
    teams[r.away] = next.away
    asOf = r.date
  }
  return { ...start, teams, asOf }
}

/** Population standard deviation of the home margin, rounded to 0.1. */
export function marginSigma(results: readonly GameResult[]): number {
  if (results.length < 2) throw new Error('marginSigma needs at least 2 results')
  const margins = results.map((r) => r.homeScore - r.awayScore)
  const mean = margins.reduce((a, b) => a + b, 0) / margins.length
  const variance = margins.reduce((a, m) => a + (m - mean) ** 2, 0) / margins.length
  return Math.round(Math.sqrt(variance) * 10) / 10
}

export async function loadRatings(path: string): Promise<Ratings> {
  return RatingsSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}

export function p0For(r: Ratings, home: string, away: string): number {
  return eloProbability(r.teams[home] ?? ELO_MEAN, r.teams[away] ?? ELO_MEAN)
}

export function eloSum(r: Ratings, home: string, away: string): number {
  return (r.teams[home] ?? ELO_MEAN) + (r.teams[away] ?? ELO_MEAN)
}
