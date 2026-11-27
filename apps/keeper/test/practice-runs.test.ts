// R8: the Practice runs. Each replays one of the 12 recordings at 6x as a PRACTICE game, named
// `practice-<espnId>p<n>`, and its draft cites the recording's public file as the `replay` source.
import type { ReplayGame } from '@horagon/sdk/replay'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Ratings } from '../src/elo'
import { buildEvidence } from '../src/evidence'
import { loadReplayDir, replayFeed } from '../src/feeds/replay'
import { gameIdOf } from '../src/feeds/types'
import { DEFAULT_TIMINGS } from '../src/planner'
import {
  fixtureUrl,
  PRACTICE_FIXTURES_DIR,
  PRACTICE_LEAD_SECS,
  PRACTICE_SEEDS,
  PRACTICE_SPEED,
  PracticeFeed,
  practiceRun,
  practiceSourceUrl,
  runOf,
  scaleTimings,
  tagFor,
} from '../src/practice/runs'

const RATINGS: Ratings = { asOf: '2026-11-17', sigma: 13, teams: {} }
/** 2026-12-06 07:00 ET: no NBA game near. */
const T0 = Date.parse('2026-12-06T12:00:00Z') / 1000
const BASE = 'https://example.test/repo/tests/fixtures/replay'
let fixtures: ReplayGame[]
beforeAll(async () => {
  fixtures = await loadReplayDir(PRACTICE_FIXTURES_DIR)
})

describe('Practice timings, seeds and links', () => {
  it('divides every timing by the speed, rounding up: end_ts is S + 1,800', () => {
    expect(PRACTICE_SPEED).toBe(6)
    expect(PRACTICE_LEAD_SECS).toBe(600)
    expect(scaleTimings(DEFAULT_TIMINGS, PRACTICE_SPEED)).toEqual({
      createLeadSecs: 600,
      endOffsetSecs: 1_800,
      createGraceSecs: 300,
      finalStableSecs: 10,
      feedSilentAlertSecs: 20,
      feedSilentSecs: 100,
      feedSilentWatchSecs: 800,
      notStartedSecs: 14_400,
      postponedResolveSecs: 100_800,
      missingSourceSecs: 300,
      secondSourceWaitSecs: 100,
    })
    expect(PRACTICE_SEEDS).toEqual({ featured: 300_000_000n, regular: 300_000_000n })
  })

  it('takes PRACTICE_SOURCE_URL from the environment only: required, https, no trailing slash', () => {
    expect(practiceSourceUrl(`${BASE}/`)).toBe(BASE)
    expect(() => practiceSourceUrl(undefined)).toThrow(/PRACTICE_SOURCE_URL is not set/)
    expect(() => practiceSourceUrl('')).toThrow(/PRACTICE_SOURCE_URL is not set/)
    expect(() => practiceSourceUrl('http://example.test/replay')).toThrow(/must be https/)
    expect(() => practiceSourceUrl('not a url')).toThrow(/not a URL/)
  })

  it('links each recording by its file name', () => {
    const f = fixtures.find((x) => x.espnEventId === '401910007')
    expect(f && fixtureUrl(BASE, f)).toBe(`${BASE}/2026-11-18-MEM-at-CLE.json`)
  })
})

describe('Practice runs', () => {
  it('tags each run and reads the tag back', () => {
    expect([tagFor(0), tagFor(11), tagFor(35), tagFor(36)]).toEqual(['p0', 'pb', 'pz', 'p10'])
    expect(runOf('401910007p6')).toEqual({ eventId: '401910007', tag: 'p6' })
    expect(runOf('401910007')).toBeNull()
    expect(runOf('401910007r1')).toBeNull()
  })

  it('cycles through the 12 recordings, tipping off 10 min after the start', () => {
    expect(fixtures).toHaveLength(12)
    const first = practiceRun({ n: 0, now: T0, fixtures, ratings: RATINGS })
    expect(first).toMatchObject({
      id: 'practice-401910014p0',
      league: 'PRACTICE',
      externalId: '401910014p0',
      gameDate: '2026-12-06',
      home: 'OKC',
      away: 'ATL',
      status: 'scheduled',
    })
    expect(first.scheduledTipoff.getTime()).toBe((T0 + 600) * 1000)
    expect(first.p0).toBeGreaterThan(0)
    expect(first.p0).toBeLessThan(1)
    const twelfth = practiceRun({ n: 12, now: T0, fixtures, ratings: RATINGS })
    expect(twelfth.id).toBe('practice-401910014pc')
    expect(twelfth.home).toBe(first.home)
    const homes = Array.from(
      { length: 12 },
      (_, n) => practiceRun({ n, now: T0, fixtures, ratings: RATINGS }).home,
    )
    expect(new Set(homes).size).toBe(12)
  })
})

describe('the replay feed and PracticeFeed', () => {
  it('replays under the league it is given, NBA by default', async () => {
    const one = fixtures.filter((f) => f.espnEventId === '401910007')
    const at = new Date(T0 * 1000)
    const nba = await replayFeed(one, { tag: 'r1', tipoff: at, now: () => at }).fetchDay(
      '2026-12-06',
    )
    const practice = await replayFeed(one, {
      tag: 'p6',
      tipoff: at,
      now: () => at,
      league: 'PRACTICE',
    }).fetchDay('2026-12-06')
    expect(nba.games.map(gameIdOf)).toEqual(['nba-401910007r1'])
    expect(practice.games.map(gameIdOf)).toEqual(['practice-401910007p6'])
    expect(nba.games[0]?.sourceUrl).toBeUndefined()
  })

  it('plays each run at 6x from its own recording, each game naming its file', async () => {
    let t = T0
    const feed = new PracticeFeed({ fixtures, now: () => new Date(t * 1000), sourceBase: BASE })
    const run = practiceRun({ n: 6, now: T0, fixtures, ratings: RATINGS })
    expect(run.id).toBe('practice-401910007p6')
    feed.setRuns([run])
    const before = await feed.fetchDay(run.gameDate)
    expect(before.games.map((g) => [gameIdOf(g), g.status, g.sourceUrl])).toEqual([
      [run.id, 'scheduled', `${BASE}/2026-11-18-MEM-at-CLE.json`],
    ])
    // MEM@CLE went final 9,173.8 s after its recorded tip-off: 1,529 s here.
    t = T0 + 600 + 1_520
    expect((await feed.fetchDay(run.gameDate)).games[0]?.status).toBe('live')
    t = T0 + 600 + 1_530
    expect((await feed.fetchDay(run.gameDate)).games[0]).toMatchObject({
      league: 'PRACTICE',
      status: 'final',
      homeScore: 121,
      awayScore: 124,
    })
    expect((await feed.fetchDay('2026-12-07')).games).toEqual([])
    feed.setRuns([])
    expect((await feed.fetchDay(run.gameDate)).games).toEqual([])
  })
})

describe('Practice evidence', () => {
  it('names its first source replay, linking the recording', () => {
    const ev = buildEvidence({
      game: { league: 'PRACTICE', externalId: '401910007p6', home: 'CLE', away: 'MEM' },
      draft: {
        status: 'final',
        homeScore: 121,
        awayScore: 124,
        periods: [
          [30, 33],
          [28, 30],
          [33, 31],
          [30, 30],
        ],
        sourceUrl: `${BASE}/2026-11-18-MEM-at-CLE.json`,
        fetchedAt: new Date(T0 * 1000),
      },
      kind: 0,
    })
    expect(ev.league).toBe('PRACTICE')
    expect(ev.outcome).toBe('no')
    expect(ev.sources).toEqual([
      {
        name: 'replay',
        url: `${BASE}/2026-11-18-MEM-at-CLE.json`,
        fetchedAt: '2026-12-06T12:00:00Z',
      },
    ])
    const nba = buildEvidence({
      game: { league: 'NBA', externalId: '401910007', home: 'CLE', away: 'MEM' },
      draft: {
        status: 'final',
        homeScore: 121,
        awayScore: 124,
        periods: ev.periods,
        sourceUrl: 'https://site.api.espn.com/x',
        fetchedAt: new Date(T0 * 1000),
      },
      kind: 0,
    })
    expect(nba.sources[0]?.name).toBe('espn')
  })
})
