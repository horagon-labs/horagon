import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clockToSecs, type ReplayGame } from '@horagon/sdk/replay'
import { describe, expect, it, vi } from 'vitest'
import { espnFeed, espnStatus, FeedError, parseEspnScoreboard, RawArchive } from '../src/feeds/espn'
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

  it('reads 0 on the clock only at the ESPN end of a period: a live 0.0 is 1, none read is null', () => {
    type Status = { clock?: number; type: { name: string } }
    type Ev = { competitions: Array<{ status: Status }> }
    /** The live game's clockSecs with ESPN's clock (undefined: none) and status name. */
    const at = (clock: number | undefined, name?: string) => {
      const body = structuredClone(scoreboard)
      const s = (body.events[0] as Ev).competitions[0]?.status
      if (!s) throw new Error('fixture')
      if (clock === undefined) delete s.clock
      else s.clock = clock
      if (name) s.type.name = name
      return parseEspnScoreboard(body).games[0]?.clockSecs
    }
    expect(at(0.4)).toBe(1)
    expect(at(0.1)).toBe(1)
    // Free throws or a review at 0.0 are still in progress: a tie there goes to overtime.
    expect(at(0)).toBe(1)
    expect(at(0, 'STATUS_IN_PROGRESS')).toBe(1)
    expect(at(45.3)).toBe(45)
    expect(at(undefined)).toBeNull()
    // ESPN's end of a period is the horn, whatever the clock says.
    expect(at(0.1, 'STATUS_END_PERIOD')).toBe(0)
    expect(at(0, 'STATUS_END_PERIOD')).toBe(0)
  })

  it('maps GS, NY, NO, SA, UTAH and WSH to NBA tricodes', () => {
    const pairs = [
      ['GS', 'GSW'],
      ['NY', 'NYK'],
      ['NO', 'NOP'],
      ['SA', 'SAS'],
      ['UTAH', 'UTA'],
      ['WSH', 'WAS'],
    ] as const
    for (const [espn, nba] of pairs) {
      const body = structuredClone(scoreboard)
      const c = (
        body.events[0] as {
          competitions: Array<{ competitors: Array<{ team: { abbreviation: string } }> }>
        }
      ).competitions[0]
      if (!c?.competitors[0]) throw new Error('fixture')
      c.competitors[0].team.abbreviation = espn
      expect(parseEspnScoreboard(body).games[0]?.home).toBe(nba)
    }
  })

  it('skips a live event with a missing or unreadable score, keeps a scheduled one at 0-0', () => {
    type Ev = { competitions: Array<{ competitors: Array<{ score?: string }> }> }
    const live = structuredClone(scoreboard)
    delete (live.events[0] as Ev).competitions[0]?.competitors[0]?.score
    expect(parseEspnScoreboard(live).skipped).toBe(1)
    const garbled = structuredClone(scoreboard)
    const c = (garbled.events[0] as Ev).competitions[0]?.competitors[1]
    if (c) c.score = '7x'
    expect(parseEspnScoreboard(garbled).skipped).toBe(1)
    const pre = structuredClone(scoreboard)
    for (const t of (pre.events[2] as Ev).competitions[0]?.competitors ?? []) {
      delete t.score
    }
    const r = parseEspnScoreboard(pre)
    expect(r.skipped).toBe(0)
    expect(r.games[2]).toMatchObject({ status: 'scheduled', homeScore: 0, awayScore: 0 })
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
    expect(espnStatus({ name: 'STATUS_SUSPENDED', state: 'in', completed: false })).toBe(
      'postponed',
    )
    expect(espnStatus({ name: 'STATUS_POSTPONED', state: 'post', completed: true })).toBe(
      'postponed',
    )
    expect(espnStatus({ name: 'STATUS_WHATEVER', state: 'post', completed: false })).toBeNull()
  })

  it('skips and counts an event with an unrecognised post status', () => {
    const odd = structuredClone(scoreboard.events[0]) as {
      competitions: [{ status: { type: unknown } }]
    }
    odd.competitions[0].status.type = {
      name: 'STATUS_WHATEVER',
      state: 'post',
      completed: false,
    }
    const r = parseEspnScoreboard({ events: [odd] })
    expect(r.games).toHaveLength(0)
    expect(r.skipped).toBe(1)
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

  it('fetches with a dated URL, archives the raw body, and sends only our headers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'espn-'))
    try {
      const urls: string[] = []
      const headers: unknown[] = []
      const ok = espnFeed({
        archive: new RawArchive(dir),
        fetchImpl: (async (url: string, init?: RequestInit) => {
          urls.push(url)
          headers.push(init?.headers)
          return new Response(JSON.stringify(scoreboard), { status: 200 })
        }) as typeof fetch,
      })
      const snap = await ok.fetchDay('2026-11-18')
      expect(urls[0]).toMatch(/scoreboard\?dates=20261118$/)
      expect(headers[0]).toEqual({ 'user-agent': 'horagon-keeper/0.1', accept: 'application/json' })
      expect(snap.games).toHaveLength(3)
      expect(snap.skipped).toBe(0)
      const archived = (await readFile(join(dir, '2026-11-18.ndjson'), 'utf8')).trim().split('\n')
      expect(JSON.parse(archived[0] ?? '{}')).toMatchObject({
        src: 'espn-scoreboard',
        url: urls[0],
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports the skipped events of a 200 answer', async () => {
    const feed = espnFeed({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ events: [...scoreboard.events, { id: 'x' }] }), {
          status: 200,
        })) as typeof fetch,
    })
    const snap = await feed.fetchDay('2026-11-18')
    expect(snap.games).toHaveLength(3)
    expect(snap.skipped).toBe(1)
  })

  it('throws FeedError for HTTP errors, network failures, timeouts and invalid JSON', async () => {
    const feedOf = (impl: () => Promise<Response>) =>
      espnFeed({ fetchImpl: impl as unknown as typeof fetch })
    const http = await feedOf(async () => new Response('secret body', { status: 403 }))
      .fetchDay('2026-11-18')
      .catch((e: unknown) => e)
    expect(http).toBeInstanceOf(FeedError)
    expect(http).toMatchObject({ message: 'espn answered 403', status: 403 })

    const boom = new TypeError('fetch failed')
    const net = await feedOf(async () => {
      throw boom
    })
      .fetchDay('2026-11-18')
      .catch((e: unknown) => e)
    expect(net).toBeInstanceOf(FeedError)
    expect(net).toMatchObject({ message: 'espn: network error', cause: boom })

    const late = await feedOf(async () => {
      throw new DOMException('too slow', 'TimeoutError')
    })
      .fetchDay('2026-11-18')
      .catch((e: unknown) => e)
    expect(late).toBeInstanceOf(FeedError)
    expect((late as FeedError).message).toBe('espn: request timed out')

    const junk = await feedOf(async () => new Response('<html>nope</html>', { status: 200 }))
      .fetchDay('2026-11-18')
      .catch((e: unknown) => e)
    expect(junk).toBeInstanceOf(FeedError)
    expect((junk as FeedError).message).toBe('espn: body is not JSON')
  })

  it('returns the snapshot when the archive cannot be written, and reports it', async () => {
    const causes: unknown[] = []
    const feed = espnFeed({
      archive: {
        write: async () => Promise.reject(new Error('disk full')),
      } as unknown as RawArchive,
      onArchiveError: (c) => causes.push(c),
      fetchImpl: (async () => new Response(JSON.stringify(scoreboard))) as typeof fetch,
    })
    expect((await feed.fetchDay('2026-11-18')).games).toHaveLength(3)
    expect(causes).toHaveLength(1)
  })

  it('warns once by default when the archive cannot be written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const feed = espnFeed({
        archive: {
          write: async () => Promise.reject(new Error('disk full')),
        } as unknown as RawArchive,
        fetchImpl: (async () => new Response(JSON.stringify(scoreboard))) as typeof fetch,
      })
      expect((await feed.fetchDay('2026-11-18')).games).toHaveLength(3)
      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0]?.[0])
      expect(line).toBe('espn: archive write failed: disk full')
      expect(line).not.toContain('http')
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps a postponed or canceled event without scores; skips a final one', () => {
    type Ev = {
      competitions: Array<{
        status: { type: { name: string; state: string; completed: boolean } }
        competitors: Array<{ score?: string }>
      }>
    }
    const make = (name: string, state: string, completed: boolean) => {
      const body = structuredClone(scoreboard)
      const c = (body.events[0] as Ev).competitions[0]
      if (!c) throw new Error('fixture')
      c.status.type = { name, state, completed }
      for (const t of c.competitors) delete t.score
      return parseEspnScoreboard(body)
    }
    for (const [name, status] of [
      ['STATUS_POSTPONED', 'postponed'],
      ['STATUS_CANCELED', 'canceled'],
    ] as const) {
      const r = make(name, 'post', false)
      expect(r.skipped).toBe(0)
      expect(r.games[0]).toMatchObject({ status, homeScore: 0, awayScore: 0 })
    }
    const fin = make('STATUS_FINAL', 'post', true)
    expect(fin.skipped).toBe(1)
    expect(fin.games).toHaveLength(2)
  })

  it('labels a timeout while reading the body as a timeout, not as invalid JSON', async () => {
    const feed = espnFeed({
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new DOMException('too slow', 'TimeoutError')
        },
      })) as unknown as typeof fetch,
    })
    const err = await feed.fetchDay('2026-11-18').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FeedError)
    expect((err as FeedError).message).toBe('espn: request timed out')
    expect((err as FeedError).cause).toBeInstanceOf(DOMException)
  })

  it('refuses a game date that is not a real calendar date', async () => {
    const feed = espnFeed({
      fetchImpl: (async () => {
        throw new Error('must not be called')
      }) as typeof fetch,
    })
    for (const bad of ['../../etc/passwd', '2026-13-01', '2026-02-30', '20261118', '']) {
      await expect(feed.fetchDay(bad)).rejects.toBeInstanceOf(FeedError)
    }
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
    expect(clockToSecs('0.1')).toBe(1)
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

  it('never shows a later frame early when a fixture is unsorted', async () => {
    const unsorted: ReplayGame = { ...fixture, frames: [...fixture.frames].reverse() }
    const feed = replayFeed([unsorted], {
      tag: 'u1',
      tipoff: new Date('2026-11-25T12:00:00Z'),
      now: () => new Date('2026-11-25T13:25:00Z'),
    })
    expect((await feed.fetchDay('2026-11-25')).games[0]).toMatchObject({
      status: 'live',
      period: 3,
      homeScore: 70,
    })
  })

  it('shifts relative to the earliest tip-off, whatever the file order', async () => {
    const later: ReplayGame = {
      ...fixture,
      espnEventId: '1',
      tipoffUtc: '2026-11-19T02:30:00.000Z',
      frames: fixture.frames.map((f) => ({
        ...f,
        t: new Date(new Date(f.t).getTime() + 9_000_000).toISOString(),
      })),
    }
    const feed = replayFeed([later, fixture], {
      tag: 'o1',
      tipoff: new Date('2026-11-25T12:00:00Z'),
      now: () => new Date(0),
    })
    const games = (await feed.fetchDay('2026-11-25')).games
    const early = games.find((g) => g.externalId === '401910007o1')
    const lateGame = games.find((g) => g.externalId === '1o1')
    expect(early?.tipoff).toEqual(new Date('2026-11-25T12:00:00Z'))
    expect(lateGame?.tipoff).toEqual(new Date('2026-11-25T14:30:00Z'))
  })

  it('refuses a tag that would make the game id too long or unsafe', () => {
    expect(() =>
      replayFeed([fixture], { tag: 'bad-tag', tipoff: new Date(), now: () => new Date() }),
    ).toThrow()
    expect(() =>
      replayFeed([fixture], { tag: '123', tipoff: new Date(), now: () => new Date() }),
    ).toThrow(/letter/)
    const longId = { ...fixture, espnEventId: '40191000712345' }
    expect(() =>
      replayFeed([longId], { tag: 'abc', tipoff: new Date(), now: () => new Date() }),
    ).toThrow(/16/)
  })
})

// The 12 games of 2026-11-18 recorded by spike S4 (ESPN only: the NBA CDN answered 403).
const RECORDED = join(import.meta.dirname, '../../../tests/fixtures/replay')

describe('replay of the 2026-11-18 recording', () => {
  // The earliest recorded tip-off lands at 01:00Z on 2026-12-02, so every game falls on the ET
  // date 2026-12-01, like the recorded night.
  const TIPOFF = new Date('2026-12-02T01:00:00Z')
  const DATE = '2026-12-01'

  async function recorded() {
    const games = await loadReplayDir(RECORDED)
    let now = new Date(0)
    const feed = replayFeed(games, { tag: 't', tipoff: TIPOFF, now: () => now })
    const origin = Math.min(...games.map((g) => new Date(g.tipoffUtc).getTime()))
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
