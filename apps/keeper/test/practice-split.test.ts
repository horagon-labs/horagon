// R8: the main keeper, the schedule, the ratings, the treasury, the watchdog and the deploy guard
// work on NBA games only; a PRACTICE game is left to the Practice process.
import {
  type DbHandle,
  getGame,
  type ScheduledGame,
  setFeatured,
  updateGameLive,
  upsertMarket,
  upsertScheduledGames,
} from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Alerter } from '../src/alerts'
import { applyResults, type Ratings } from '../src/elo'
import type { Feed, FeedGame } from '../src/feeds/types'
import { deployBlockers } from '../src/ops/deploy-check'
import { watchdogRun } from '../src/ops/watchdog'
import { DEFAULT_SEEDS, DEFAULT_TIMINGS } from '../src/planner'
import { currentRatings, scheduleTick } from '../src/schedule'
import { Keeper, type KeeperDeps } from '../src/tick'
import { upcomingSeeds } from '../src/treasury'
import { PracticeChain, program } from './practice-chain'

const S = 1_795_000_000
const silent = pino({ level: 'silent' })

const row = (id: string, league: string, externalId: string): ScheduledGame => ({
  id,
  league,
  externalId,
  gameDate: '2026-11-18',
  home: 'CLE',
  away: 'MEM',
  scheduledTipoff: new Date(S * 1000),
  status: 'scheduled',
  p0: 0.62,
})

let h: DbHandle
let chain: PracticeChain
let alerts: Array<[string, string]>
const alerter: Alerter = { send: async (k, t) => void alerts.push([k, t]) }

const emptyFeed = (at: () => number, games: FeedGame[] = []): Feed => ({
  name: 'empty',
  fetchDay: async (date) => ({
    source: 'test',
    url: 'https://example.test/feed',
    fetchedAt: new Date(at() * 1000),
    games: games.filter((g) => g.gameDate === date),
  }),
})

function keeperOf(over: Partial<KeeperDeps>, at: () => number): Keeper {
  return new Keeper({
    db: h.db,
    sender: chain.sender,
    program,
    attestor: chain.attestor,
    feed: emptyFeed(at),
    alerts: alerter,
    log: silent,
    now: at,
    timings: DEFAULT_TIMINGS,
    seeds: DEFAULT_SEEDS,
    sigma: 13,
    priority: { normal: 10_000, halt: 200_000 },
    feedEverySecs: 0,
    ...over,
  })
}

beforeEach(async () => {
  h = await createTestDb()
  chain = new PracticeChain(h.db, S, DEFAULT_TIMINGS.endOffsetSecs)
  alerts = []
})
afterEach(async () => {
  await h.close()
})

const named = (actions: Array<{ type: string; gameId: string }>) =>
  actions.map((a) => `${a.type} ${a.gameId}`)

describe('one league per keeper (R8)', () => {
  it('the main keeper ticks only NBA games; a keeper given PRACTICE only PRACTICE ones', async () => {
    await upsertScheduledGames(h.db, [
      row('nba-401910007', 'NBA', '401910007'),
      row('practice-401910007p0', 'PRACTICE', '401910007p0'),
    ])
    const now = S - 3_600
    const main = keeperOf({}, () => now)
    expect(named(await main.tick())).toEqual(['create nba-401910007'])
    expect(named(await main.tick())).toEqual([])

    const practice = keeperOf({ leagues: ['PRACTICE'] }, () => now)
    expect(named(await practice.tick())).toEqual(['create practice-401910007p0'])
    expect(chain.sends).toEqual(['create nba-401910007', 'create practice-401910007p0'])
    expect((await getGame(h.db, 'practice-401910007p0'))?.markets).toHaveLength(1)

    // Hours later, with no feed: whatever the main keeper alerts, it never names the Practice
    // game, whose market it never loads.
    const later = S + DEFAULT_TIMINGS.endOffsetSecs - 600
    const mainLater = keeperOf({}, () => later)
    const actions = named(await mainLater.tick())
    expect(actions.some((a) => a.includes('practice-'))).toBe(false)
    expect(alerts.some(([k]) => k.includes('practice-'))).toBe(false)
  })

  it('currentRatings learns from NBA finals only', async () => {
    const base: Ratings = {
      asOf: '2026-11-17',
      sigma: 13,
      teams: { CLE: 1_500, MEM: 1_500, OKC: 1_500, ATL: 1_500 },
    }
    await upsertScheduledGames(h.db, [
      {
        ...row('nba-401910007', 'NBA', '401910007'),
        scheduledTipoff: new Date('2026-11-19T00:00:00Z'),
      },
      {
        ...row('practice-401910014p0', 'PRACTICE', '401910014p0'),
        gameDate: '2026-12-06',
        home: 'OKC',
        away: 'ATL',
        scheduledTipoff: new Date('2026-12-06T12:10:00Z'),
      },
    ])
    for (const [id, homeScore, awayScore] of [
      ['nba-401910007', 121, 124],
      ['practice-401910014p0', 112, 117],
    ] as const) {
      await updateGameLive(h.db, id, {
        status: 'final',
        homeScore,
        awayScore,
        period: 4,
        clockSecs: null,
        periods: [],
        modelProb: null,
        feedUpdatedAt: new Date(),
      })
    }
    const now = Date.parse('2026-12-07T00:00:00Z') / 1000
    expect(await currentRatings(h.db, base, now)).toEqual(
      applyResults(base, [
        { date: '2026-11-18', home: 'CLE', away: 'MEM', homeScore: 121, awayScore: 124 },
      ]),
    )
  })

  it('scheduleTick picks the featured NBA games of a date whatever a PRACTICE row says', async () => {
    const date = '2026-12-06'
    const tip = new Date('2026-12-07T00:30:00Z')
    await upsertScheduledGames(h.db, [
      {
        ...row('practice-401910014p0', 'PRACTICE', '401910014p0'),
        gameDate: date,
        scheduledTipoff: new Date('2026-12-06T15:10:00Z'),
      },
    ])
    // A Practice row marked featured by hand must not stand for the night's featured choice.
    await setFeatured(h.db, date, ['practice-401910014p0'])
    const nba: FeedGame = {
      league: 'NBA',
      externalId: '401920001',
      gameDate: date,
      home: 'BOS',
      away: 'NYK',
      tipoff: tip,
      status: 'scheduled',
      period: 0,
      clockSecs: null,
      homeScore: 0,
      awayScore: 0,
      periods: [],
      cup: false,
    }
    const now = Date.parse('2026-12-06T14:00:00Z') / 1000
    const ratings: Ratings = { asOf: '2026-11-17', sigma: 13, teams: {} }
    const out = await scheduleTick({
      db: h.db,
      feed: emptyFeed(() => now, [nba]),
      ratings,
      now: () => now,
    })
    expect(out.featured).toEqual(['nba-401920001'])
    const practice = await getGame(h.db, 'practice-401910014p0')
    expect(practice).toMatchObject({ league: 'PRACTICE', status: 'scheduled', p0: 0.62 })
  })

  it('the treasury counts no seed for a PRACTICE game', async () => {
    const now = S - 7_200
    await upsertScheduledGames(h.db, [
      row('nba-401910007', 'NBA', '401910007'),
      row('practice-401910007p0', 'PRACTICE', '401910007p0'),
    ])
    expect(await upcomingSeeds({ db: h.db, seeds: DEFAULT_SEEDS, now: () => now })).toEqual([
      DEFAULT_SEEDS.regular,
    ])
  })

  it('the watchdog reads no game night from a PRACTICE game alone', async () => {
    const t = S
    await upsertScheduledGames(h.db, [
      { ...row('practice-401910007p0', 'PRACTICE', '401910007p0') },
    ])
    expect(await watchdogRun(h.db, alerter, t, silent)).toBe(0)
    expect(alerts).toEqual([])
    await upsertScheduledGames(h.db, [row('nba-401910007', 'NBA', '401910007')])
    expect(await watchdogRun(h.db, alerter, t, silent)).toBe(2)
    expect(alerts.map(([k]) => k)).toEqual(['heartbeat'])
  })

  it('the deploy guard is not blocked by an open Practice market', async () => {
    await upsertScheduledGames(h.db, [row('practice-401910007p0', 'PRACTICE', '401910007p0')])
    await upsertMarket(h.db, {
      pubkey: 'P1',
      gameId: 'practice-401910007p0',
      kind: 0,
      marketId: '1',
      gameMarketPda: 'GM1',
      yesMint: 'Y1',
      noMint: 'N1',
      initialPriceBps: 6_200,
      endTs: new Date((S + 1_800) * 1000),
      seedAmount: 300_000_000n,
      status: 'open',
    })
    const g = await getGame(h.db, 'practice-401910007p0')
    if (!g) throw new Error('no Practice game')
    expect(deployBlockers([g], S + 60)).toEqual([])
    expect(deployBlockers([{ ...g, league: 'NBA' }], S + 60)).toHaveLength(1)
  })
})
