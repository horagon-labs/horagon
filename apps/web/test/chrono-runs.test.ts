import type { GameHistory } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import { runKeyOf } from '../components/chrono/dial-look'
import { history, market, NOW } from '../lib/chrono/fixtures'
import {
  findRuns,
  freshRun,
  latestRun,
  RUN_FRESH_SECS,
  type Run,
  runLine,
} from '../lib/chrono/runs'

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
      {
        team: 'home',
        start: t + 120,
        from: t + 120,
        to: t + 240,
        points: 8,
        priceFrom: 0.74,
        priceTo: 0.77,
      },
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

describe('the run flash key (spec 2.4: once per run, M7)', () => {
  const keyOf = (h: GameHistory) => runKeyOf(h, latestRun(findRuns(h, MKT)))
  // CLE's streak, one basket of 4 at a time, whose best 3-minute stretch slides forward.
  const streak: [number, number, number][] = [
    [0, 0, 0],
    [10, 4, 0],
    [100, 8, 0],
  ]

  it('keeps one key while a streak grows from 8–0 to 10–0 to 12–0', () => {
    const eight = made(streak)
    const ten = made([...streak, [150, 10, 0]])
    const twelve = made([...streak, [150, 10, 0], [190, 12, 0]])
    const runs = [eight, ten, twelve].map((h) => findRuns(h, MKT))
    expect(runs.map((r) => r.map((x) => x.points))).toEqual([[8], [10], [12]])
    expect(keyOf(ten)).toBe(keyOf(eight))
    expect(keyOf(twelve)).toBe(keyOf(eight))
  })

  it('keeps the key when the best 3-minute stretch slides on within the streak', () => {
    const eight = made(streak)
    const slid = made([...streak, [200, 12, 0], [250, 16, 0]])
    expect(findRuns(slid, MKT)).toMatchObject([{ points: 12, from: NOW + 100, start: NOW + 10 }])
    expect(keyOf(slid)).toBe(keyOf(eight))
  })

  it('gives a new streak by either team a new key', () => {
    const eight = made(streak)
    const answered = made([...streak, [130, 8, 4], [160, 8, 8]])
    const again = made([...streak, [130, 8, 4], [160, 8, 8], [190, 12, 8], [220, 16, 8]])
    expect(keyOf(answered)).not.toBe(keyOf(eight))
    expect(keyOf(again)).not.toBe(keyOf(answered))
    expect(keyOf(again)).not.toBe(keyOf(eight))
  })
})

describe('runLine (spec 3.2)', () => {
  const run: Run = {
    team: 'home',
    start: 0,
    from: 0,
    to: 120,
    points: 8,
    priceFrom: 0.74,
    priceTo: 0.77,
  }

  it('says the team, the run and the price move', () => {
    expect(runLine(run, TEAMS)).toBe('CLE on an 8–0 run · CLE to win 74% → 77% in 2 min')
  })

  it('says the price held when nobody moved it, never "62 → 62" (R5)', () => {
    expect(runLine({ ...run, priceFrom: 0.62, priceTo: 0.62 }, TEAMS)).toBe(
      'CLE on an 8–0 run · the price held at 62%',
    )
  })

  it('reads an away run on the away side’s price', () => {
    const away: Run = { ...run, team: 'away', to: 50, priceFrom: 0.6, priceTo: 0.5 }
    expect(runLine(away, TEAMS)).toBe('MEM on an 8–0 run · MEM to win 40% → 50% in 1 min')
  })

  it('picks the article and drops the price without one', () => {
    expect(runLine({ ...run, points: 12, priceTo: null }, TEAMS)).toBe('CLE on a 12–0 run')
    expect(runLine({ ...run, points: 11, priceFrom: null }, TEAMS)).toBe('CLE on an 11–0 run')
  })

  it('prints the edges as <1 and >99 instead of certainty', () => {
    const edge: Run = { ...run, priceFrom: 0.004, priceTo: 0.996 }
    expect(runLine(edge, TEAMS)).toBe('CLE on an 8–0 run · CLE to win <1% → >99% in 2 min')
    expect(runLine({ ...edge, team: 'away' }, TEAMS)).toBe(
      'MEM on an 8–0 run · MEM to win >99% → <1% in 2 min',
    )
  })

  it('takes the newest run', () => {
    expect(latestRun([])).toBeNull()
    expect(latestRun([run, { ...run, from: 500 }])?.from).toBe(500)
  })
})

describe('freshRun (spec 3.2)', () => {
  it('keeps a run up to RUN_FRESH_SECS after its last basket, by the newest snapshot', () => {
    const h = history()
    const run = latestRun(findRuns(h, MKT))
    const first = h.snapshots[0]
    if (!run || !first) throw new Error('fixture')
    const at = (ts: number): GameHistory => ({
      ...h,
      snapshots: [...h.snapshots, { ...first, ts }],
    })
    expect(freshRun(null, h)).toBeNull()
    expect(freshRun(run, h)).toBe(run)
    expect(freshRun(run, at(run.to + RUN_FRESH_SECS))).toBe(run)
    expect(freshRun(run, at(run.to + RUN_FRESH_SECS + 1))).toBeNull()
  })
})
