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
