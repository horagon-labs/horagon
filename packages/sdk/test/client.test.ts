import { describe, expect, it } from 'vitest'
import { HoragonClient } from '../src/client'

function scripted(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; method: string }> = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    const next = responses.shift()
    if (!next) throw new Error('no more responses')
    if (next instanceof Error) throw next
    return next
  }) as typeof fetch
  return { calls, fetchImpl }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const health = {
  ok: true,
  db: { ok: true, ms: 1 },
  rpc: { ok: true, ms: 1, slot: 1 },
  keeper: { ok: true, heartbeatAgeSecs: 3 },
  version: 'x',
}

describe('HoragonClient', () => {
  it('retries a GET after a network failure, with the query string', async () => {
    const s = scripted([new TypeError('fetch failed'), json({ games: [] })])
    const c = new HoragonClient({
      baseUrl: 'https://h.test/api/v1/',
      fetch: s.fetchImpl,
      retryDelayMs: 1,
    })
    await expect(c.games.list({ date: '2026-11-24' })).resolves.toEqual([])
    expect(s.calls.map((x) => x.url)).toEqual([
      'https://h.test/api/v1/games?date=2026-11-24',
      'https://h.test/api/v1/games?date=2026-11-24',
    ])
  })

  it('never retries a POST', async () => {
    const s = scripted([new TypeError('fetch failed'), json({ signature: '1'.repeat(88) })])
    const c = new HoragonClient({
      baseUrl: 'https://h.test/api/v1',
      fetch: s.fetchImpl,
      retryDelayMs: 1,
    })
    await expect(c.trade.submit('AAAA')).rejects.toMatchObject({ code: 'NETWORK' })
    expect(s.calls).toHaveLength(1)
  })

  it('maps a non-problem error status by HTTP code', async () => {
    const s = scripted([new Response('busy', { status: 429, headers: { 'retry-after': '7' } })])
    const c = new HoragonClient({ baseUrl: 'https://h.test', fetch: s.fetchImpl, retries: 0 })
    await expect(c.positions('x')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSecs: 7,
    })
  })

  it('refuses a response of the wrong shape with a clear NETWORK error', async () => {
    const s = scripted([json({ games: [{ id: 1 }] })])
    const c = new HoragonClient({ baseUrl: 'https://h.test', fetch: s.fetchImpl, retries: 0 })
    await expect(c.games.list()).rejects.toMatchObject({
      code: 'NETWORK',
      message: expect.stringContaining('unexpected response shape'),
    })
  })

  it('reads health on 503 without throwing', async () => {
    const s = scripted([json({ ...health, ok: false }, 503)])
    const c = new HoragonClient({ baseUrl: 'https://h.test', fetch: s.fetchImpl })
    await expect(c.health()).resolves.toMatchObject({ ok: false })
  })
})

describe('HoragonClient.me (R7)', () => {
  const WALLET = '11111111111111111111111111111111'
  const game = {
    id: 'nba-401810001',
    league: 'NBA',
    home: 'MEM',
    away: 'LAC',
    scheduledTipoff: '2026-11-28T00:30:00.000Z',
    status: 'live',
    homeScore: 60,
    awayScore: 55,
    period: 3,
    clockSecs: 300,
    featured: false,
    modelProb: 0.62,
    markets: [],
    updatedAt: '2026-11-28T01:30:00.000Z',
  }
  const me = {
    wallet: WALLET,
    night: '2026-11-27',
    now: 1_795_000_000,
    nights: 1,
    games: [
      {
        game,
        practice: false,
        positions: [
          {
            market: WALLET,
            gameId: game.id,
            kind: 'winner',
            side: 'home',
            shares: '38.72',
            costUsdc: '20',
            valueUsdc: '24.0064',
            pnlUsdc: '4.0064',
            price: 0.62,
            marketStatus: 'open',
            outcome: null,
            claimable: false,
            team: 'MEM',
            avgPrice: 0.5165,
            status: 'open',
            challengeEndsAt: null,
            call: { model: 0.62, result: null, points: null },
          },
        ],
        ifHomeWins: { payoutUsdc: '38.72', netUsdc: '18.72' },
        ifAwayWins: { payoutUsdc: '0', netUsdc: '-20' },
      },
    ],
    vsModel: { points: null, settled: 0, pending: 1, practicePoints: null },
    earlierClaimable: 0,
    nextGames: [],
  }

  it('asks /me/{wallet} with the teams as one comma list, and parses the answer', async () => {
    const s = scripted([json(me), json(me)])
    const c = new HoragonClient({ baseUrl: 'https://h.test/api/v1', fetch: s.fetchImpl })
    await expect(c.me(WALLET, ['MEM', 'LAC'])).resolves.toEqual(me)
    await c.me(WALLET)
    expect(s.calls.map((x) => x.url)).toEqual([
      `https://h.test/api/v1/me/${WALLET}?teams=MEM%2CLAC`,
      `https://h.test/api/v1/me/${WALLET}`,
    ])
  })

  it('sends no teams parameter for an empty list', async () => {
    const s = scripted([json(me)])
    const c = new HoragonClient({ baseUrl: 'https://h.test/api/v1', fetch: s.fetchImpl })
    await c.me(WALLET, [])
    expect(s.calls[0]?.url).toBe(`https://h.test/api/v1/me/${WALLET}`)
  })

  it('refuses an answer of the wrong shape', async () => {
    const s = scripted([json({ ...me, games: [{ ...me.games[0], practice: 'no' }] })])
    const c = new HoragonClient({ baseUrl: 'https://h.test', fetch: s.fetchImpl, retries: 0 })
    await expect(c.me(WALLET)).rejects.toMatchObject({ code: 'NETWORK' })
  })

  it('passes NOT_FOUND through while My Game-day is switched off', async () => {
    const problem = {
      type: 'about:blank',
      title: 'Not found',
      status: 404,
      detail: 'This feature is not available right now',
      code: 'NOT_FOUND',
    }
    const s = scripted([
      new Response(JSON.stringify(problem), {
        status: 404,
        headers: { 'content-type': 'application/problem+json' },
      }),
    ])
    const c = new HoragonClient({ baseUrl: 'https://h.test', fetch: s.fetchImpl })
    await expect(c.me(WALLET)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // A 404 is an answer, not a transient failure: it is never retried.
    expect(s.calls).toHaveLength(1)
  })

  it('reads the nights the positions answer carries when the flag is on', async () => {
    const s = scripted([json({ wallet: WALLET, usdcBalance: '1', positions: [], nights: 2 })])
    const c = new HoragonClient({ baseUrl: 'https://h.test', fetch: s.fetchImpl })
    await expect(c.portfolio(WALLET)).resolves.toMatchObject({ nights: 2 })
  })
})
