import { describe, expect, it } from 'vitest'
import { errorSignature, HoragonClient } from '../src/client'
import { isHoragonError } from '../src/errors'

type Step = Response | Error | (() => Promise<Response>)

function scripted(steps: Step[]) {
  const calls: string[] = []
  const fetchImpl = (async (url: string) => {
    calls.push(url)
    const next = steps.shift()
    if (!next) throw new Error('no more responses')
    if (next instanceof Error) throw next
    if (typeof next === 'function') return next()
    return next
  }) as typeof fetch
  return { calls, fetchImpl }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const SIG = '1'.repeat(88)
const status = (s: string) => ({ signature: SIG, status: s, slot: 1, error: null })
const client = (steps: Step[], extra: Record<string, number> = {}) => {
  const s = scripted(steps)
  return {
    s,
    c: new HoragonClient({
      baseUrl: 'https://h.test/api/v1',
      fetch: s.fetchImpl,
      retryDelayMs: 1,
      ...extra,
    }),
  }
}

describe('problem+json mapping', () => {
  it('keeps code, hint, programCode, retry-after and the request id', async () => {
    const { c } = client(
      [
        json(
          {
            type: 'about:blank',
            title: 'Slippage',
            status: 409,
            detail: 'Price moved',
            code: 'SLIPPAGE_EXCEEDED',
            hint: 'Quote again',
            programCode: 6007,
            requestId: 'req-1',
          },
          409,
          { 'retry-after': '3' },
        ),
      ],
      { retries: 0 },
    )
    const err = await c.markets.get('m').catch((e: unknown) => e)
    expect(err).toMatchObject({
      code: 'SLIPPAGE_EXCEEDED',
      hint: 'Quote again',
      programCode: 6007,
      retryAfterSecs: 3,
    })
    expect((err as Error).message).toBe('Price moved (request id req-1)')
  })

  it('appends a sponsor rejection reason and falls back to the x-request-id header', async () => {
    const { c } = client([
      json(
        {
          type: 'about:blank',
          title: 'No',
          status: 403,
          detail: 'Rejected',
          code: 'SPONSOR_REJECTED',
          reason: 'COMPUTE_BUDGET',
        },
        403,
        { 'x-request-id': 'hdr-9' },
      ),
    ])
    await expect(c.trade.submit('AAAA')).rejects.toMatchObject({
      code: 'SPONSOR_REJECTED',
      message: 'Rejected [COMPUTE_BUDGET] (request id hdr-9)',
    })
  })

  it('reads an HTTP-date Retry-After as at least one second', async () => {
    const date = new Date(Date.now() + 30_000).toUTCString()
    const { c } = client([new Response('x', { status: 429, headers: { 'retry-after': date } })], {
      retries: 0,
    })
    const err = (await c.positions('w').catch((e: unknown) => e)) as { retryAfterSecs: number }
    expect(err.retryAfterSecs).toBeGreaterThanOrEqual(28)
    expect(err.retryAfterSecs).toBeLessThanOrEqual(31)
    const past = client(
      [
        new Response('x', {
          status: 429,
          headers: { 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' },
        }),
      ],
      { retries: 0 },
    )
    await expect(past.c.positions('w')).rejects.toMatchObject({ retryAfterSecs: 1 })
  })
})

describe('every failure is a HoragonError', () => {
  it('turns an HTML 200 into NETWORK and retries it for a GET', async () => {
    const html = () => new Response('<html>', { status: 200 })
    const { c, s } = client([html(), html(), json({ games: [] })])
    await expect(c.games.list()).resolves.toEqual([])
    expect(s.calls).toHaveLength(3)
  })

  it('turns a 502 HTML page on health into NETWORK', async () => {
    const { c } = client([new Response('<html>', { status: 502 })], { retries: 0 })
    const err = await c.health().catch((e: unknown) => e)
    expect(isHoragonError(err) && err.code).toBe('NETWORK')
  })

  it('turns a problem body on health (404) into a HoragonError, not a ZodError', async () => {
    const { c } = client([json({ detail: 'nope' }, 404)], { retries: 0 })
    const err = await c.health().catch((e: unknown) => e)
    expect(isHoragonError(err) && err.code).toBe('NETWORK')
  })

  it('never retries a POST whose body is unreadable', async () => {
    const { c, s } = client([new Response('<html>', { status: 200 }), json({ signature: SIG })])
    await expect(c.faucet('w')).rejects.toMatchObject({ code: 'NETWORK' })
    expect(s.calls).toHaveLength(1)
  })

  it('gives NETWORK when the server never answers within timeoutMs', async () => {
    // A fetch that only settles when the client's abort signal fires.
    const c = new HoragonClient({
      baseUrl: 'https://h.test',
      retries: 0,
      timeoutMs: 20,
      fetch: ((_u: string, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(init.signal?.reason))
        })) as typeof fetch,
    })
    await expect(c.health()).rejects.toMatchObject({ code: 'NETWORK' })
  })

  it('gives NETWORK for a body read that is aborted', async () => {
    const broken = () => {
      const body = new ReadableStream({
        pull(ctrl) {
          ctrl.error(new DOMException('timed out', 'TimeoutError'))
        },
      })
      return Promise.resolve(new Response(body, { status: 200 }))
    }
    const { c, s } = client([broken, json({ games: [] })])
    await expect(c.games.list()).resolves.toEqual([])
    expect(s.calls).toHaveLength(2)
  })
})

describe('query and path building', () => {
  it('keeps the query string without URLSearchParams#size', async () => {
    const orig = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, 'size')
    Object.defineProperty(URLSearchParams.prototype, 'size', {
      get: () => undefined,
      configurable: true,
    })
    try {
      const { c, s } = client([json({ games: [] })])
      await c.games.list({ date: '2026-11-24', status: 'live' })
      expect(s.calls[0]).toBe('https://h.test/api/v1/games?date=2026-11-24&status=live')
    } finally {
      if (orig) Object.defineProperty(URLSearchParams.prototype, 'size', orig)
    }
  })

  it('encodes every path segment', async () => {
    const { c, s } = client([
      json({ positions: [], usdc: '0' }),
      new Response('{}', { status: 404 }),
      new Response('{}', { status: 404 }),
    ])
    await c.portfolio('a/b?c').catch(() => undefined)
    await c.markets.get('a/b?c').catch(() => undefined)
    await c.trade.status('a/b?c').catch(() => undefined)
    expect(s.calls.slice(0, 3)).toEqual([
      'https://h.test/api/v1/positions/a%2Fb%3Fc',
      'https://h.test/api/v1/markets/a%2Fb%3Fc',
      'https://h.test/api/v1/tx/a%2Fb%3Fc',
    ])
  })
})

describe('trade.submit', () => {
  /** The API's answer to a send whose outcome is unknown (RFC 9457 extension `signature`). */
  const unsureSend = (extra: Record<string, unknown> = { signature: SIG }) =>
    json(
      {
        type: 'about:blank',
        title: 'Network',
        status: 502,
        detail: 'The RPC did not confirm it received the transaction',
        code: 'NETWORK',
        hint: `It may still land. Check GET /api/v1/tx/${SIG} before building a new trade.`,
        requestId: 'req-9',
        ...extra,
      },
      502,
    )

  it('tells the caller not to rebuild after a lost answer, and never to resend', async () => {
    const { c } = client([new TypeError('boom')])
    const err = (await c.trade.submit('AAAA').catch((e: unknown) => e)) as {
      code: string
      hint: string
    }
    expect(err.code).toBe('NETWORK')
    expect(err.hint).toContain('Do not rebuild')
    expect(err.hint).not.toMatch(/resend|send (it|the same)/i)
    expect(errorSignature(err)).toBeUndefined()
  })

  it('keeps the signature of a send that may have landed, pointing at its status', async () => {
    const { c, s } = client([unsureSend()])
    const err = await c.trade.submit('AAAA').catch((e: unknown) => e)
    expect(isHoragonError(err)).toBe(true)
    expect(s.calls).toHaveLength(1)
    expect(err).toMatchObject({ code: 'NETWORK', signature: SIG })
    expect(errorSignature(err)).toBe(SIG)
    const { hint } = err as { hint: string }
    expect(hint).toContain(`GET /api/v1/tx/${SIG}`)
    expect(hint).toContain('trade.status')
    expect(hint).toMatch(/blockhash has expired/)
    expect(hint).not.toMatch(/resend|send (it|the same)/i)
  })

  it('reads the signature on any problem, keeping the API hint outside submit', async () => {
    const { c } = client([unsureSend()])
    const err = await c.faucet('w').catch((e: unknown) => e)
    expect(errorSignature(err)).toBe(SIG)
    expect(err).toMatchObject({
      code: 'NETWORK',
      hint: `It may still land. Check GET /api/v1/tx/${SIG} before building a new trade.`,
    })
  })

  it('ignores a signature member that is not a signature', async () => {
    for (const signature of ['not a signature', 42, null]) {
      const { c } = client([unsureSend({ signature })])
      const err = await c.trade.submit('AAAA').catch((e: unknown) => e)
      expect(err).toMatchObject({ code: 'NETWORK' })
      expect(errorSignature(err)).toBeUndefined()
      expect(err).not.toHaveProperty('signature')
    }
  })

  it('reads no signature from anything but a HoragonError', () => {
    expect(errorSignature(Object.assign(new Error('x'), { signature: SIG }))).toBeUndefined()
    expect(errorSignature(undefined)).toBeUndefined()
  })
})

describe('trade.waitFor', () => {
  it('returns the first terminal status', async () => {
    const { c, s } = client([json(status('pending')), json(status('confirmed'))])
    await expect(c.trade.waitFor(SIG, { pollMs: 1 })).resolves.toMatchObject({
      status: 'confirmed',
    })
    expect(s.calls).toHaveLength(2)
  })

  it('resolves, not throws, on a failed transaction', async () => {
    const { c } = client([json(status('failed'))])
    await expect(c.trade.waitFor(SIG, { pollMs: 1 })).resolves.toMatchObject({ status: 'failed' })
  })

  it('keeps polling after a transient failure', async () => {
    const { c, s } = client([
      new TypeError('x'),
      new Response('bad', { status: 503 }),
      json(status('finalized')),
    ])
    await expect(c.trade.waitFor(SIG, { pollMs: 1 })).resolves.toMatchObject({
      status: 'finalized',
    })
    expect(s.calls).toHaveLength(3)
  })

  it('stops at the deadline with a NETWORK error, even if a poll hangs', async () => {
    const c = new HoragonClient({
      baseUrl: 'https://h.test',
      fetch: ((_u: string, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(init.signal?.reason))
        })) as typeof fetch,
    })
    const t0 = Date.now()
    const err = await c.trade.waitFor(SIG, { timeoutMs: 80, pollMs: 5 }).catch((e: unknown) => e)
    expect(err).toMatchObject({
      code: 'NETWORK',
      message: expect.stringContaining('not confirmed in time'),
    })
    expect((err as { hint: string }).hint).not.toMatch(/resend/i)
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('does not swallow a non-transient error', async () => {
    const { c } = client([json({ detail: 'x' }, 404)])
    await expect(c.trade.waitFor(SIG, { pollMs: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('round 2 guards', () => {
  it('N1: a null body on a keyed GET is a shape error, not a TypeError', async () => {
    const { c } = client([json(null)], { retries: 0 })
    await expect(c.games.list()).rejects.toMatchObject({
      code: 'NETWORK',
      message: expect.stringContaining('unexpected response shape'),
    })
  })

  it('N2: waitFor rethrows a shape error at once', async () => {
    const { c, s } = client([json({ nope: 1 }), json(status('confirmed'))])
    await expect(c.trade.waitFor(SIG, { pollMs: 1 })).rejects.toMatchObject({
      message: expect.stringContaining('unexpected response shape'),
    })
    expect(s.calls).toHaveLength(1)
  })

  it('N2: the deadline error carries the last transient error as cause', async () => {
    const boom = new TypeError('down')
    const c = new HoragonClient({
      baseUrl: 'https://h.test',
      fetch: (async () => {
        throw boom
      }) as typeof fetch,
    })
    const err = (await c.trade
      .waitFor(SIG, { timeoutMs: 30, pollMs: 5 })
      .catch((e: unknown) => e)) as Error
    expect(err.message).toContain('not confirmed in time')
    expect((err.cause as Error).cause).toBe(boom)
  })

  it('N3: timeoutMs 0 still polls once', async () => {
    const { c, s } = client([json(status('confirmed'))])
    await expect(c.trade.waitFor(SIG, { timeoutMs: 0 })).resolves.toMatchObject({
      status: 'confirmed',
    })
    expect(s.calls).toHaveLength(1)
  })
})
