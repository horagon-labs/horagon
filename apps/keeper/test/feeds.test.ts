import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clockToSecs, type ReplayGame } from '@horagon/sdk/replay'
import { describe, expect, it } from 'vitest'
import { espnFeed, espnStatus, parseEspnScoreboard, RawArchive } from '../src/feeds/espn'
import { loadReplayDir, rebuildPeriods, replayFeed } from '../src/feeds/replay'
import { type FeedGame, periodsConsistent } from '../src/feeds/types'

const scoreboard = JSON.parse(
  await readFile(new URL('./fixtures/espn-scoreboard-2026-11-18.json', import.meta.url), 'utf8'),
) as { events: Array<Record<string, unknown>> }

describe('ESPN scoreboard', () => {
  it('parses live, halftime and scheduled games with tricodes and linescores', () => {
    const { games, skipped } = parseEspnScoreboard(scoreboard)
    expect(skipped).toBe(0)
    expect(games.map((g) => [g.externalId, g.away, g.home, g.status, g.period])).toEqual([
      ['401910007', 'MEM', 'CLE', 'live', 3],
      ['401910009', 'MIL', 'MIA', 'live', 2],
      ['401910015', 'BOS', 'DEN', 'scheduled', 0],
    ])
    const cle = games[0]
    expect(cle).toMatchObject({ homeScore: 74, clockSecs: 676, gameDate: '2026-11-18', cup: false })
    expect(cle?.periods.slice(0, 2)).toEqual([
      [37, expect.any(Number)],
      [35, expect.any(Number)],
    ])
    expect(games[2]?.clockSecs).toBeNull()
  })

  it('maps GS, NY, NO, SA, UTAH and WSH to NBA tricodes', () => {
    const body = structuredClone(scoreboard)
    const c = (
      body.events[0] as {
        competitions: Array<{ competitors: Array<{ team: { abbreviation: string } }> }>
      }
    ).competitions[0]
    if (!c?.competitors[0] || !c.competitors[1]) throw new Error('fixture')
    c.competitors[0].team.abbreviation = 'GS'
    c.competitors[1].team.abbreviation = 'UTAH'
    const g = parseEspnScoreboard(body).games[0]
    expect([g?.home, g?.away].sort()).toEqual(['GSW', 'UTA'])
  })

  it('only reads post + completed as final; postponed and canceled from the name', () => {
    expect(espnStatus({ name: 'STATUS_FINAL', state: 'post', completed: true })).toBe('final')
    expect(espnStatus({ name: 'STATUS_POSTPONED', state: 'post', completed: false })).toBe(
      'postponed',
    )
    expect(espnStatus({ name: 'STATUS_POSTPONED', state: 'pre', completed: false })).toBe(
      'postponed',
    )
    expect(espnStatus({ name: 'STATUS_CANCELED', state: 'post', completed: false })).toBe(
      'canceled',
    )
    expect(espnStatus({ name: 'STATUS_DELAYED', state: 'pre', completed: false })).toBe('scheduled')
    expect(espnStatus({ name: 'STATUS_WHATEVER', state: 'post', completed: false })).toBe(
      'postponed',
    )
  })

  it('skips and counts malformed events instead of throwing', () => {
    const body = { events: [...scoreboard.events, { id: 'x' }, null, 5] }
    const r = parseEspnScoreboard(body)
    expect(r.games).toHaveLength(3)
    expect(r.skipped).toBe(3)
    expect(parseEspnScoreboard('nonsense')).toEqual({ games: [], skipped: 0 })
  })

  it('detects an NBA Cup game from the competition notes', () => {
    const body = structuredClone(scoreboard)
    const c = (body.events[0] as { competitions: Array<{ notes: unknown[] }> }).competitions[0]
    if (!c) throw new Error('fixture')
    c.notes = [{ headline: 'Emirates NBA Cup - East Group B' }]
    expect(parseEspnScoreboard(body).games[0]?.cup).toBe(true)
  })

  it('fetches with a dated URL, archives the raw body, and reports HTTP errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'espn-'))
    const urls: string[] = []
    const ok = espnFeed({
      archive: new RawArchive(dir),
      fetchImpl: (async (url: string) => {
        urls.push(url)
        return new Response(JSON.stringify(scoreboard), { status: 200 })
      }) as typeof fetch,
    })
    const snap = await ok.fetchDay('2026-11-18')
    expect(urls[0]).toMatch(/scoreboard\?dates=20261118$/)
    expect(snap.games).toHaveLength(3)
    const archived = (await readFile(join(dir, '2026-11-18.ndjson'), 'utf8')).trim().split('\n')
    expect(JSON.parse(archived[0] ?? '{}')).toMatchObject({ src: 'espn-scoreboard', url: urls[0] })

    const down = espnFeed({
      fetchImpl: (async () => new Response('', { status: 403 })) as typeof fetch,
    })
    await expect(down.fetchDay('2026-11-18')).rejects.toThrow('espn answered 403')
  })
})

const fixture: ReplayGame = {
  schema: 'horagon.replay.v0',
  gameDate: '2026-11-18',
  home: 'CLE',
  away: 'MEM',
  tipoffUtc: '2026-11-19T00:00:00Z',
  espnEventId: '401910007',
  frames: [
    {
      t: '2026-11-18T23:00:00Z',
      source: 'espn',
      status: 'pre',
      period: 0,
      clock: '0.0',
      homeScore: 0,
      awayScore: 0,
    },
    {
      t: '2026-11-19T00:10:00Z',
      source: 'espn',
      status: 'live',
      period: 1,
      clock: '0.0',
      homeScore: 30,
      awayScore: 25,
    },
    {
      t: '2026-11-19T00:40:00Z',
      source: 'espn',
      status: 'live',
      period: 2,
      clock: '0.0',
      homeScore: 58,
      awayScore: 52,
    },
    {
      t: '2026-11-19T01:20:00Z',
      source: 'espn',
      status: 'live',
      period: 3,
      clock: '5:30',
      homeScore: 70,
      awayScore: 70,
    },
    {
      t: '2026-11-19T01:40:00Z',
      source: 'espn',
      status: 'live',
      period: 3,
      clock: '0.0',
      homeScore: 84,
      awayScore: 82,
    },
    {
      t: '2026-11-19T02:20:00Z',
      source: 'espn',
      status: 'final',
      period: 4,
      clock: '0.0',
      homeScore: 111,
      awayScore: 106,
    },
    {
      t: '2026-11-19T02:20:00Z',
      source: 'nba',
      status: 'final',
      period: 4,
      clock: 'PT00M00.00S',
      homeScore: 111,
      awayScore: 106,
    },
  ],
}

describe('replay feed', () => {
  it('parses ESPN and NBA clocks', () => {
    expect(clockToSecs('11:16')).toBe(676)
    expect(clockToSecs('45.3')).toBe(45)
    expect(clockToSecs('PT05M30.00S')).toBe(330)
    expect(clockToSecs('garbage')).toBe(0)
  })

  it('rebuilds per-period points from score-change frames', () => {
    expect(rebuildPeriods(fixture.frames.filter((f) => f.source === 'espn'))).toEqual([
      [30, 25],
      [28, 27],
      [26, 30],
      [27, 24],
    ])
  })

  it('shifts the recording onto a new tip-off and tags the game id', async () => {
    let now = new Date('2026-11-25T11:00:00Z')
    const feed = replayFeed([fixture], {
      tag: 'r1',
      tipoff: new Date('2026-11-25T12:00:00Z'),
      now: () => now,
    })
    const before = await feed.fetchDay('2026-11-25')
    expect(before.games[0]).toMatchObject({
      externalId: '401910007r1',
      status: 'scheduled',
      homeScore: 0,
    })
    now = new Date('2026-11-25T13:25:00Z')
    const mid = (await feed.fetchDay('2026-11-25')).games[0]
    expect(mid).toMatchObject({ status: 'live', period: 3, clockSecs: 330, homeScore: 70 })
    now = new Date('2026-11-25T14:30:00Z')
    const end = (await feed.fetchDay('2026-11-25')).games[0]
    expect(end).toMatchObject({ status: 'final', homeScore: 111, awayScore: 106 })
    expect(end?.periods).toHaveLength(4)
    expect((await feed.fetchDay('2026-11-26')).games).toEqual([])
  })

  it('plays faster with a speed, keeping the frame order', async () => {
    let now = new Date('2026-11-25T12:21:15Z')
    const feed = replayFeed([fixture], {
      tag: 'r2',
      tipoff: new Date('2026-11-25T12:00:00Z'),
      now: () => now,
      speed: 4,
    })
    // 85 game minutes after tip-off at speed 1 are 21 min 15 s at speed 4.
    const mid = (await feed.fetchDay('2026-11-25')).games[0]
    expect(mid).toMatchObject({ status: 'live', period: 3, clockSecs: 330, homeScore: 70 })
    now = new Date('2026-11-25T12:37:30Z')
    const end = (await feed.fetchDay('2026-11-25')).games[0]
    expect(end).toMatchObject({ status: 'final', homeScore: 111, awayScore: 106 })
    expect(() =>
      replayFeed([fixture], { tag: 'r3', tipoff: new Date(), now: () => new Date(), speed: 0.5 }),
    ).toThrow(/speed/)
  })

  it('refuses a tag that would make the game id too long or unsafe', () => {
    expect(() =>
      replayFeed([fixture], { tag: 'bad-tag', tipoff: new Date(), now: () => new Date() }),
    ).toThrow()
    const longId = { ...fixture, espnEventId: '40191000712345' }
    expect(() =>
      replayFeed([longId], { tag: 'abc', tipoff: new Date(), now: () => new Date() }),
    ).toThrow(/16/)
  })
})

// The 12 games of 2026-11-18 recorded by spike S4 (ESPN only: the NBA CDN answered 403).
const RECORDED = join(import.meta.dirname, '../../../tests/fixtures/replay')

describe('replay of the 2026-11-18 recording', () => {
  // The first file (ATL at OKC, 01:00Z) lands at 01:00Z on 2026-12-02, so every game falls on
  // the ET date 2026-12-01, like the recorded night.
  const TIPOFF = new Date('2026-12-02T01:00:00Z')
  const DATE = '2026-12-01'

  async function recorded() {
    const games = await loadReplayDir(RECORDED)
    let now = new Date(0)
    const feed = replayFeed(games, { tag: 't', tipoff: TIPOFF, now: () => now })
    const origin = new Date(games[0]?.tipoffUtc ?? 0).getTime()
    const at = (iso: string) => new Date(TIPOFF.getTime() + new Date(iso).getTime() - origin)
    const state = async (game: ReplayGame, time: Date): Promise<FeedGame | undefined> => {
      now = time
      const day = await feed.fetchDay(DATE)
      return day.games.find((g) => g.externalId === `${game.espnEventId}t`)
    }
    return { games, at, state }
  }

  it('loads all 12 games with ESPN frames and normalised tip-off times', async () => {
    const { games } = await recorded()
    expect(games).toHaveLength(12)
    for (const g of games) {
      expect(g.frames.every((f) => f.source === 'espn')).toBe(true)
      expect(g.tipoffUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/)
      expect(g.frames[0]).toMatchObject({ status: 'pre', period: 0 })
    }
  })

  it('reads every game final only at the whistle, with periods that add up', async () => {
    const { games, at, state } = await recorded()
    for (const g of games) {
      const whistle = g.frames.findIndex((f) => f.status === 'final')
      const before = g.frames[whistle - 1]
      const final = g.frames[whistle]
      if (!before || !final) throw new Error(`${g.away}@${g.home}: no final frame`)
      expect((await state(g, at(before.t)))?.status).toBe('live')
      const end = await state(g, at(final.t))
      expect(end).toMatchObject({ status: 'final', homeScore: final.homeScore, clockSecs: null })
      expect(end && periodsConsistent(end)).toBe(true)
    }
  })

  it('stays final when the clock resets to 12:00 an hour after the whistle', async () => {
    const { games, at, state } = await recorded()
    const reset = games.filter((g) => g.frames.at(-1)?.clock === '12:00')
    expect(reset.length).toBe(10)
    for (const g of reset) {
      const whistle = g.frames.find((f) => f.status === 'final')
      const last = g.frames.at(-1)
      if (!whistle || !last) throw new Error('no frames')
      const atWhistle = await state(g, at(whistle.t))
      const later = await state(g, new Date(at(last.t).getTime() + 3_600_000))
      expect(later).toEqual(atWhistle)
    }
  })

  it('passes on a score that goes down within a game', async () => {
    const { games, at, state } = await recorded()
    const corrected = games.filter((g) =>
      g.frames.some(
        (f, i) =>
          i > 0 &&
          (f.homeScore < (g.frames[i - 1]?.homeScore ?? 0) ||
            f.awayScore < (g.frames[i - 1]?.awayScore ?? 0)),
      ),
    )
    expect(corrected.map((g) => `${g.away}@${g.home}`).sort()).toEqual([
      'GSW@DAL',
      'HOU@IND',
      'UTA@LAL',
    ])
    for (const g of corrected) {
      const i = g.frames.findIndex(
        (f, k) =>
          k > 0 &&
          (f.homeScore < (g.frames[k - 1]?.homeScore ?? 0) ||
            f.awayScore < (g.frames[k - 1]?.awayScore ?? 0)),
      )
      const frame = g.frames[i]
      if (!frame) throw new Error('no frame')
      expect(await state(g, at(frame.t))).toMatchObject({
        homeScore: frame.homeScore,
        awayScore: frame.awayScore,
      })
    }
  })
})
