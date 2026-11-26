import { describe, expect, it, vi } from 'vitest'
import {
  Balldontlie,
  BdlError,
  bdlGameUrl,
  bdlTeam,
  fetchGames,
  findGame,
  NBA_TRICODES,
  secondGame,
} from '../src/second-source/balldontlie'
import { verdictOf } from '../src/second-source/check'

// A balldontlie final: BOS @ LAL, 104-112, ET night 2026-11-19 (Plan B's fixture).
const FINAL = {
  id: 1,
  date: '2026-11-19',
  status: 'Final',
  period: 4,
  home_team_score: 112,
  visitor_team_score: 104,
  home_q1: 30,
  home_q2: 28,
  home_q3: 27,
  home_q4: 27,
  visitor_q1: 25,
  visitor_q2: 26,
  visitor_q3: 27,
  visitor_q4: 26,
  home_team: { id: 14, abbreviation: 'LAL' },
  visitor_team: { id: 2, abbreviation: 'BOS' },
}
const KEY = 'x'.repeat(16)
const page = (data: unknown[]) => vi.fn(async () => Response.json({ data, meta: {} }))
const asFetch = (f: unknown) => f as typeof fetch

describe('teams', () => {
  it('knows the 30 NBA tricodes the keeper uses, as balldontlie spells them', () => {
    expect(new Set(NBA_TRICODES).size).toBe(30)
    expect(bdlTeam('NYK')).toBe('NYK')
    // The keeper maps ESPN's own spellings to these before a game is stored (feeds/espn.ts).
    for (const code of ['GSW', 'NOP', 'SAS', 'UTA', 'WAS', 'BKN', 'PHX', 'CHA'])
      expect(bdlTeam(code)).toBe(code)
    expect(bdlTeam('GS')).toBeNull()
    expect(bdlTeam('XXX')).toBeNull()
  })
})

describe('fetchGames', () => {
  it('asks for one ET date with the key in the header only', async () => {
    const f = page([FINAL])
    const games = await fetchGames('2026-11-19', KEY, asFetch(f))
    expect(games).toHaveLength(1)
    const [url, init] = (f.mock.calls[0] ?? []) as unknown as [URL, RequestInit]
    expect(url.toString()).toBe(
      'https://api.balldontlie.io/v1/games?dates%5B%5D=2026-11-19&per_page=100',
    )
    expect(url.toString()).not.toContain(KEY)
    expect((init.headers as Record<string, string>).Authorization).toBe(KEY)
  })

  it('throws a BdlError with the status, never the key', async () => {
    const f = vi.fn(async () => new Response(`slow down ${KEY}`, { status: 429 }))
    const err = await fetchGames('2026-11-19', KEY, asFetch(f)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BdlError)
    expect((err as BdlError).status).toBe(429)
    expect(String(err)).not.toContain(KEY)
    const bad = vi.fn(async () => Response.json({ nope: true }))
    await expect(fetchGames('2026-11-19', KEY, asFetch(bad))).rejects.toThrow(/shape/)
    const down = vi.fn(async () => {
      throw new Error(`connect refused ${KEY}`)
    })
    const lost = await fetchGames('2026-11-19', KEY, asFetch(down)).catch((e: unknown) => e)
    expect(lost).toMatchObject({ name: 'BdlError', status: 0 })
    expect(String(lost)).not.toContain(KEY)
  })

  it('finds a game by its home and away tricodes', () => {
    expect(findGame([FINAL], 'LAL', 'BOS')?.id).toBe(1)
    expect(findGame([FINAL], 'BOS', 'LAL')).toBeUndefined()
    expect(findGame([FINAL], 'LAL', 'XXX')).toBeUndefined()
  })

  it('reads the state and the totals, and links the game', () => {
    expect(secondGame(FINAL)).toEqual({ id: 1, state: 'final', homeScore: 112, awayScore: 104 })
    expect(secondGame({ ...FINAL, status: '4th Qtr' }).state).toBe('live')
    expect(secondGame({ ...FINAL, status: '2026-11-20T03:30:00Z', period: 0 }).state).toBe(
      'scheduled',
    )
    expect(secondGame({ ...FINAL, status: 'Postponed' }).state).toBe('postponed')
    expect(secondGame({ ...FINAL, home_team_score: null }).homeScore).toBeNull()
    expect(bdlGameUrl(1)).toBe('https://api.balldontlie.io/v1/games/1')
  })
})

describe('the polite client', () => {
  const T = 1_795_000_000

  it('asks at most once a minute per ET date', async () => {
    const f = page([FINAL])
    const bdl = new Balldontlie(KEY, asFetch(f))
    expect(await bdl.games('2026-11-19', T)).toEqual({ games: [FINAL], fetchedAt: T })
    expect(await bdl.games('2026-11-19', T + 59)).toBeNull()
    // Another date has its own minute.
    expect(await bdl.games('2026-11-20', T + 59)).not.toBeNull()
    expect(await bdl.games('2026-11-19', T + 60)).toEqual({ games: [FINAL], fetchedAt: T + 60 })
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('leaves a date alone for 120 s after a 429, and a minute after any other failure', async () => {
    let status = 429
    const f = vi.fn(async () =>
      status === 200 ? Response.json({ data: [FINAL] }) : new Response('', { status }),
    )
    const bdl = new Balldontlie(KEY, asFetch(f))
    await expect(bdl.games('2026-11-19', T)).rejects.toMatchObject({ status: 429 })
    status = 200
    expect(await bdl.games('2026-11-19', T + 119)).toBeNull()
    expect(await bdl.games('2026-11-19', T + 120)).not.toBeNull()
    status = 503
    await expect(bdl.games('2026-11-19', T + 180)).rejects.toMatchObject({ status: 503 })
    expect(await bdl.games('2026-11-19', T + 239)).toBeNull()
    expect(f).toHaveBeenCalledTimes(3)
  })
})

describe('verdictOf', () => {
  const draft = { homeScore: 112, awayScore: 104 }
  const game = secondGame(FINAL)

  it('match: final with both totals equal to the draft', () => {
    expect(verdictOf(draft, game)).toBe('match')
  })

  it('mismatch: final with either total different', () => {
    expect(verdictOf({ homeScore: 112, awayScore: 103 }, game)).toBe('mismatch')
    expect(verdictOf({ homeScore: 110, awayScore: 104 }, game)).toBe('mismatch')
  })

  it('pending: no game yet, not final yet, or a final without a total', () => {
    expect(verdictOf(draft, null)).toBe('pending')
    expect(verdictOf(draft, { ...game, state: 'live' })).toBe('pending')
    expect(verdictOf(draft, { ...game, state: 'postponed' })).toBe('pending')
    expect(verdictOf(draft, { ...game, homeScore: null })).toBe('pending')
  })

  it('off: there is no second source', () => {
    expect(verdictOf(draft, 'off')).toBe('off')
  })
})
