import { type Game, HoragonError } from '@horagon/sdk'
import { describe, expect, it, vi } from 'vitest'
import { boardModel, nextLine, upcomingOf } from '../lib/chrono/board'
import { detail, evening, game, NOW } from '../lib/chrono/fixtures'
import {
  type BoardClient,
  LOOKAHEAD_DAYS,
  loadBoard,
  loadGame,
  lookAhead,
  ttlCache,
  within,
} from '../lib/server/initial'

// NOW is 2026-11-24 9:08 PM ET.
const later = (iso: string, over: Partial<Game> = {}) =>
  game({ status: 'scheduled', scheduledTipoff: iso, markets: [], ...over })
const thu7 = later('2026-11-27T00:00:00.000Z', { id: 'nba-1' })
const thu930 = later('2026-11-27T02:30:00.000Z', { id: 'nba-2' })
const fri7 = later('2026-11-28T00:00:00.000Z', { id: 'nba-3' })
const secs = (g: Game) => Date.parse(g.scheduledTipoff) / 1000

function client(byDate: Record<string, Game[]>, get?: unknown) {
  const list = vi.fn(async (q?: { date?: string }) => byDate[q?.date ?? 'default'] ?? [])
  return {
    list,
    c: { games: { list, get: get ?? vi.fn() } } as unknown as BoardClient,
  }
}

describe('within (R5)', () => {
  it('gives the value, or undefined once late or failed', async () => {
    expect(await within(Promise.resolve(7), 50)).toBe(7)
    expect(await within(new Promise(() => {}), 5)).toBeUndefined()
    expect(await within(Promise.reject(new Error('down')), 50)).toBeUndefined()
  })
})

describe('upcomingOf and nextLine (R5)', () => {
  it('finds the first games past tonight and counts their ET day', () => {
    const u = upcomingOf([fri7, thu930, thu7], NOW)
    expect(u).toEqual({ tip: secs(thu7), count: 2 })
    expect(u && nextLine(u)).toBe('Next games: Thu, Nov 26 · 2 games from 7:00 PM ET')
    expect(nextLine({ tip: secs(fri7), count: 1 })).toBe(
      'Next games: Fri, Nov 27 · 1 game from 7:00 PM ET',
    )
  })

  it('skips tonight, the past and games no longer scheduled', () => {
    expect(upcomingOf(evening(), NOW)).toBeNull()
    expect(upcomingOf([later('2026-11-20T00:00:00.000Z')], NOW)).toBeNull()
    expect(upcomingOf([{ ...thu7, status: 'postponed' }], NOW)).toBeNull()
  })

  it('says when the next games are on an empty board, never with a follow filter', () => {
    expect(boardModel([thu7], undefined, NOW, []).next).toBe(
      'Next games: Thu, Nov 26 · 1 game from 7:00 PM ET',
    )
    const u = { tip: secs(fri7), count: 3 }
    expect(boardModel([], undefined, NOW, [], u).next).toBe(
      'Next games: Fri, Nov 27 · 3 games from 7:00 PM ET',
    )
    expect(boardModel([], undefined, NOW, [], { ...u, tip: NOW - 60 }).next).toBeNull()
    expect(boardModel([thu7], undefined, NOW, ['TOR']).next).toBeNull()
    expect(boardModel(evening(), undefined, NOW, [], u).next).toBeNull()
    expect(boardModel(undefined, undefined, NOW, [], u).next).toBeNull()
  })
})

describe('loadBoard (R5)', () => {
  it('takes tonight from the default list and asks nothing more', async () => {
    const { c, list } = client({ default: evening() })
    const b = await loadBoard(c, NOW)
    expect(b.games).toHaveLength(5)
    expect(b.upcoming).toBeNull()
    expect(b.now).toBe(NOW)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('looks ahead on an empty night, from the day after the default list', async () => {
    const { c, list } = client({ default: [], '2026-11-27': [fri7] })
    const b = await loadBoard(c, NOW)
    expect(b.games).toEqual([])
    expect(b.upcoming).toEqual({ tip: secs(fri7), count: 1 })
    // Days 2 to 7 are all asked at once (R5 review finding 8).
    expect(list.mock.calls.map((a) => a[0]?.date)).toEqual([
      undefined,
      '2026-11-26',
      '2026-11-27',
      '2026-11-28',
      '2026-11-29',
      '2026-11-30',
      '2026-12-01',
    ])
  })

  it('stops after LOOKAHEAD_DAYS, and leaves the games out when the API is late', async () => {
    const { c, list } = client({ default: [] })
    expect((await loadBoard(c, NOW)).upcoming).toBeNull()
    expect(list).toHaveBeenCalledTimes(1 + LOOKAHEAD_DAYS)
    const slow = { games: { list: () => new Promise<Game[]>(() => {}) } } as unknown as BoardClient
    expect(await loadBoard(slow, NOW, 5)).toEqual({ games: undefined, upcoming: null, now: NOW })
  })
})

describe('lookAhead (R5 review finding 8)', () => {
  /** A client whose day lists answer after `ms[date]` milliseconds (never without one). */
  function slowClient(byDate: Record<string, Game[]>, ms: Record<string, number>) {
    const list = vi.fn(
      (q?: { date?: string }) =>
        new Promise<Game[]>((resolve) => {
          const wait = ms[q?.date ?? '']
          if (wait !== undefined) setTimeout(() => resolve(byDate[q?.date ?? ''] ?? []), wait)
        }),
    )
    return { list, c: { games: { list, get: vi.fn() } } as unknown as BoardClient }
  }
  const days = ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01']
  const all = (wait: number) => Object.fromEntries(days.map((d) => [d, wait]))

  it('asks every day at once and waits one cap in all, not one per day', async () => {
    vi.useFakeTimers()
    try {
      // Each day takes 1 s: one at a time that was 6 s; at once it is 1 s, under the 1.5 s cap.
      const { c, list } = slowClient({ '2026-11-30': [fri7] }, all(1_000))
      const out = lookAhead(c, NOW, 1_500)
      expect(list).toHaveBeenCalledTimes(LOOKAHEAD_DAYS)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await out).toEqual({ tip: secs(fri7), count: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes the first day with games, even when a later day answers first', async () => {
    vi.useFakeTimers()
    try {
      const thu = later('2026-11-28T00:00:00.000Z', { id: 'nba-t' })
      const sat = later('2026-11-30T00:00:00.000Z', { id: 'nba-s' })
      const { c } = slowClient(
        { '2026-11-27': [thu], '2026-11-29': [sat] },
        { ...all(100), '2026-11-27': 900, '2026-11-29': 10 },
      )
      const out = lookAhead(c, NOW, 1_500)
      await vi.advanceTimersByTimeAsync(900)
      expect(await out).toEqual({ tip: secs(thu), count: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up at the cap, or at a day that failed, instead of skipping past it', async () => {
    vi.useFakeTimers()
    try {
      // 2026-11-27 never answers: the later day with games must not pass for the next one.
      const slow = slowClient(
        { '2026-11-29': [fri7] },
        { ...all(10), '2026-11-27': undefined as unknown as number },
      )
      const out = lookAhead(slow.c, NOW, 1_500)
      await vi.advanceTimersByTimeAsync(1_500)
      expect(await out).toBeNull()
    } finally {
      vi.useRealTimers()
    }
    const down = vi.fn(async (q?: { date?: string }) => {
      if (q?.date === '2026-11-26') throw new Error('down')
      return [fri7]
    })
    const failing = { games: { list: down, get: vi.fn() } } as unknown as BoardClient
    expect(await lookAhead(failing, NOW, 1_500)).toBeNull()
  })
})

describe('loadGame (R5)', () => {
  it('draws the game, or says at once that there is none', async () => {
    const d = detail()
    const found = client(
      {},
      vi.fn(async () => d),
    )
    expect(await loadGame(found.c, d.id, NOW)).toEqual({ game: d, missing: false, now: NOW })
    for (const code of ['NOT_FOUND', 'INVALID_INPUT'] as const) {
      const gone = client(
        {},
        vi.fn(async () => Promise.reject(new HoragonError(code, 'no'))),
      )
      expect(await loadGame(gone.c, 'nba-x', NOW)).toEqual({
        game: undefined,
        missing: true,
        now: NOW,
      })
    }
    const down = client(
      {},
      vi.fn(async () => Promise.reject(new HoragonError('NETWORK', 'x'))),
    )
    expect((await loadGame(down.c, 'nba-x', NOW)).missing).toBe(false)
  })
})

describe('ttlCache (R5)', () => {
  it('shares one answer per key for the TTL, and keeps no failed or empty answer', async () => {
    let t = 0
    const cache = ttlCache<number | undefined>(1_000, 200, () => t)
    const load = vi.fn(async () => 1)
    const keep = (v: number | undefined) => v !== undefined
    await cache('a', load, keep)
    await cache('a', load, keep)
    expect(load).toHaveBeenCalledTimes(1)
    t = 1_000
    await cache('a', load, keep)
    expect(load).toHaveBeenCalledTimes(2)

    const empty = vi.fn(async () => undefined)
    await cache('b', empty, keep)
    await cache('b', empty, keep)
    expect(empty).toHaveBeenCalledTimes(2)

    const fail = vi.fn(async (): Promise<number> => Promise.reject(new Error('down')))
    await expect(cache('c', fail, keep)).rejects.toThrow('down')
    await expect(cache('c', fail, keep)).rejects.toThrow('down')
    expect(fail).toHaveBeenCalledTimes(2)
  })

  it('holds at most max keys', async () => {
    let t = 0
    const cache = ttlCache<number>(1_000, 2, () => t)
    const load = vi.fn(async () => 1)
    const keep = () => true
    await cache('a', load, keep)
    await cache('b', load, keep)
    await cache('c', load, keep)
    t = 10
    await cache('a', load, keep)
    expect(load).toHaveBeenCalledTimes(4)
  })
})
