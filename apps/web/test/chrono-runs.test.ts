import type { GameHistory } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import { history, market, NOW } from '../lib/chrono/fixtures'
import { findRuns, latestRun, type Run, runLine } from '../lib/chrono/runs'

const MKT = market().pubkey
const TEAMS = { home: 'CLE', away: 'MEM' }

/** Snapshots from [seconds, home, away] triples, prices from [seconds, price] pairs. */
function made(snaps: [number, number, number][], prices: [number, number][] = []): GameHistory {
  return {
    gameId: 'nba-401810001',
    snapshots: snaps.map(([ts, homeScore, awayScore]) => ({
      ts: NOW + ts,
      homeScore,
      awayScore,
      period: 3,
      clockSecs: 300,
      modelProb: null,
    })),
    prices: prices.map(([ts, price]) => ({ market: MKT, ts: NOW + ts, price })),
  }
}

describe('findRuns (spec 3.1)', () => {
  it('finds 8 unanswered points in 2 minutes with the prices at both ends', () => {
    const t = NOW - 900
    expect(findRuns(history(), MKT)).toEqual([
      { team: 'home', from: t + 120, to: t + 240, points: 8, priceFrom: 0.74, priceTo: 0.77 },
    ])
  })

  it('does not count points both teams scored between two snapshots', () => {
    expect(
      findRuns(
        made([
          [0, 0, 0],
          [60, 8, 2],
        ]),
        MKT,
      ),
    ).toEqual([])
  })

  it('needs the 8 points inside 3 minutes of real time', () => {
    const slow = made([
      [0, 0, 0],
      [100, 2, 0],
      [200, 4, 0],
      [300, 6, 0],
      [400, 8, 0],
      [500, 10, 0],
    ])
    expect(findRuns(slow, MKT)).toEqual([])
    const fast = made([
      [0, 0, 0],
      [60, 3, 0],
      [120, 6, 0],
      [170, 9, 0],
      [240, 12, 0],
    ])
    expect(findRuns(fast, MKT)).toMatchObject([{ points: 12, from: NOW + 60, to: NOW + 240 }])
  })

  it('keeps one run per streak and starts over when the other team scores', () => {
    const two = made([
      [0, 0, 0],
      [30, 0, 4],
      [60, 0, 8],
      [90, 2, 8],
      [120, 5, 8],
      [150, 10, 8],
    ])
    expect(findRuns(two, MKT).map((r) => [r.team, r.points])).toEqual([
      ['away', 8],
      ['home', 10],
    ])
  })

  it('has null prices without a price for the market', () => {
    const [run] = findRuns(
      made([
        [0, 0, 0],
        [60, 8, 0],
      ]),
      MKT,
    )
    expect(run).toMatchObject({ priceFrom: null, priceTo: null })
  })

  it('takes no price from a quote that comes only after the run', () => {
    const [run] = findRuns(
      made(
        [
          [0, 0, 0],
          [60, 8, 0],
        ],
        [[100, 0.5]],
      ),
      MKT,
    )
    expect(run).toMatchObject({ priceFrom: null, priceTo: null })
    expect(runLine(run as Run, TEAMS)).toBe('CLE on an 8–0 run')
  })

  it('does not join baskets 181 seconds apart into one run', () => {
    expect(
      findRuns(
        made([
          [0, 0, 0],
          [100, 4, 0],
          [281, 8, 0],
        ]),
        MKT,
      ),
    ).toEqual([])
  })
})

describe('runLine (spec 3.2)', () => {
  const run: Run = { team: 'home', from: 0, to: 120, points: 8, priceFrom: 0.74, priceTo: 0.77 }

  it('says the team, the run and the price move', () => {
    expect(runLine(run, TEAMS)).toBe('CLE on an 8–0 run · price 74 → 77 in 2 min')
  })

  it('reads an away run on the away side’s price', () => {
    const away: Run = { ...run, team: 'away', to: 50, priceFrom: 0.6, priceTo: 0.5 }
    expect(runLine(away, TEAMS)).toBe('MEM on an 8–0 run · price 40 → 50 in 1 min')
  })

  it('picks the article and drops the price without one', () => {
    expect(runLine({ ...run, points: 12, priceTo: null }, TEAMS)).toBe('CLE on a 12–0 run')
    expect(runLine({ ...run, points: 11, priceFrom: null }, TEAMS)).toBe('CLE on an 11–0 run')
  })

  it('prints the edges as <1 and >99 instead of certainty', () => {
    const edge: Run = { ...run, priceFrom: 0.004, priceTo: 0.996 }
    expect(runLine(edge, TEAMS)).toBe('CLE on an 8–0 run · price <1 → >99 in 2 min')
    expect(runLine({ ...edge, team: 'away' }, TEAMS)).toBe(
      'MEM on an 8–0 run · price >99 → <1 in 2 min',
    )
  })

  it('takes the newest run', () => {
    expect(latestRun([])).toBeNull()
    expect(latestRun([run, { ...run, from: 500 }])?.from).toBe(500)
  })
})
