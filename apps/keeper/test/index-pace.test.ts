import type { Logger } from 'pino'
import { describe, expect, it } from 'vitest'
import {
  BACKOFF,
  backoffDelayMs,
  IndexPace,
  isRateLimited,
  RATE_LIMIT_PAGE_AFTER_MS,
  SIGNATURES_SPACING_MS,
} from '../src/index-pace'

/** A pace on a fake clock: `sleep` moves the clock, `random` is fixed unless given. */
function fakePace(o: { random?: () => number } = {}) {
  let t = 1_000_000
  const warns: Array<{ obj: Record<string, unknown>; msg: string }> = []
  const sent: Array<{ key: string; text: string }> = []
  const sleeps: number[] = []
  const pace = new IndexPace({
    log: {
      warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }),
      debug: () => {},
      info: () => {},
    } as unknown as Logger,
    alerts: {
      send: async (key, text) => {
        sent.push({ key, text })
      },
    },
    clock: () => t,
    random: o.random ?? (() => 0),
    sleep: async (ms) => {
      sleeps.push(ms)
      t += ms
    },
  })
  return {
    pace,
    warns,
    sent,
    sleeps,
    advance: (ms: number) => {
      t += ms
    },
    now: () => t,
  }
}

describe('isRateLimited', () => {
  it('reads web3.js HTTP 429 errors, JSON-RPC 429 and -32005 codes and the message', () => {
    expect(
      isRateLimited(
        new Error(
          '429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests for a specific RPC call"}}',
        ),
      ),
    ).toBe(true)
    expect(isRateLimited(Object.assign(new Error('failed to get signatures'), { code: 429 }))).toBe(
      true,
    )
    expect(isRateLimited(Object.assign(new Error('node is behind'), { code: -32005 }))).toBe(true)
    expect(isRateLimited({ status: 429 })).toBe(true)
    expect(isRateLimited(new Error('x', { cause: { status: 429 } }))).toBe(true)
    expect(isRateLimited(new Error('Too many requests from your IP'))).toBe(true)
    expect(isRateLimited('Too many requests')).toBe(true)
  })

  it('leaves other failures alone', () => {
    expect(isRateLimited(new Error('fetch failed'))).toBe(false)
    expect(isRateLimited(new Error('500 Internal Server Error'))).toBe(false)
    expect(isRateLimited(Object.assign(new Error('blockhash'), { code: -32002 }))).toBe(false)
    expect(isRateLimited(new Error('slot 14290 skipped'))).toBe(false)
    expect(isRateLimited(null)).toBe(false)
  })
})

describe('backoffDelayMs', () => {
  it('doubles from 30 s up to the 10 min cap', () => {
    const nominal = [0, 1, 2, 3, 4, 5, 6, 30].map((n) => backoffDelayMs(n, () => 0))
    expect(nominal).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000])
  })

  it('keeps the jitter within the bound, never above the nominal delay or the cap', () => {
    for (const attempt of [0, 3, 5, 12]) {
      const nominal = Math.min(BACKOFF.capMs, BACKOFF.baseMs * 2 ** attempt)
      for (const r of [0, 0.25, 0.5, 0.999999]) {
        const d = backoffDelayMs(attempt, () => r)
        expect(d).toBeLessThanOrEqual(nominal)
        expect(d).toBeGreaterThanOrEqual(Math.floor(nominal * (1 - BACKOFF.jitter)))
      }
    }
    expect(backoffDelayMs(0, () => 0.999999)).toBeLessThan(30_000)
  })
})

describe('IndexPace back-off', () => {
  it('holds reads for the delay after a rate limit, logging once with the delay', async () => {
    const f = fakePace()
    expect(await f.pace.held('index')).toBe(false)
    const delay = await f.pace.rateLimited('index', new Error('429 Too Many Requests'))
    expect(delay).toBe(30_000)
    expect(f.warns).toHaveLength(1)
    expect(f.warns[0]?.obj).toMatchObject({ source: 'index', delayMs: 30_000 })
    expect(await f.pace.held('index')).toBe(true)
    f.advance(29_999)
    expect(await f.pace.held('ata-watch')).toBe(true)
    f.advance(1)
    expect(await f.pace.held('index')).toBe(false)
    // Held passes log nothing more.
    expect(f.warns).toHaveLength(1)
  })

  it('grows the delay on each rate limit in a row and resets after a clean pass', async () => {
    const f = fakePace()
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      delays.push(await f.pace.rateLimited('index', new Error('429')))
      f.advance(delays.at(-1) ?? 0)
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
    f.pace.clean()
    expect(await f.pace.rateLimited('index', new Error('429'))).toBe(30_000)
  })

  it('applies the jitter it is given', async () => {
    const f = fakePace({ random: () => 0.5 })
    expect(await f.pace.rateLimited('index', new Error('429'))).toBe(
      Math.round(30_000 * (1 - BACKOFF.jitter * 0.5)),
    )
  })

  it('pages index-rate-limited once the pause has lasted more than 15 min, until a clean pass', async () => {
    const f = fakePace()
    let elapsed = 0
    // Rate-limited again at the end of every pause: 30 s, 1, 2, 4, 8 min = 15.5 min so far.
    for (let i = 0; i < 5; i++) {
      const d = await f.pace.rateLimited('index', new Error('429'))
      expect(f.sent).toEqual([])
      f.advance(d)
      elapsed += d
    }
    expect(elapsed).toBeGreaterThan(RATE_LIMIT_PAGE_AFTER_MS)
    await f.pace.rateLimited('index', new Error('429'))
    expect(f.sent.map((s) => s.key)).toEqual(['index-rate-limited'])
    expect(f.sent[0]?.text).toContain('15 min')
    expect(f.sent[0]?.text).toContain('HORAGON_INDEX_RPC_URL')
    // Every held pass sends it again: the alerter's window drops the repeats.
    f.advance(1_000)
    expect(await f.pace.held('index')).toBe(true)
    expect(f.sent.map((s) => s.key)).toEqual(['index-rate-limited', 'index-rate-limited'])

    f.advance(600_000)
    expect(await f.pace.held('index')).toBe(false)
    f.pace.clean()
    await f.pace.rateLimited('index', new Error('429'))
    expect(f.sent).toHaveLength(2)
  })

  it('does not page a pause streak of 15 min or less', async () => {
    const f = fakePace()
    await f.pace.rateLimited('index', new Error('429'))
    f.advance(RATE_LIMIT_PAGE_AFTER_MS)
    await f.pace.rateLimited('index', new Error('429'))
    expect(f.sent).toEqual([])
    f.advance(1)
    expect(await f.pace.held('index')).toBe(true)
    expect(f.sent.map((s) => s.key)).toEqual(['index-rate-limited'])
  })
})

describe('IndexPace signature spacing', () => {
  it('spaces signature reads at least 200 ms apart on the clock', async () => {
    const f = fakePace()
    const at: number[] = []
    for (let i = 0; i < 4; i++) {
      await f.pace.spaceSignatures()
      at.push(f.now())
    }
    const gaps = at.slice(1).map((t, i) => t - (at[i] ?? 0))
    expect(gaps).toEqual([200, 200, 200])
    expect(SIGNATURES_SPACING_MS).toBe(200)
    // Time already gone by counts.
    f.advance(150)
    await f.pace.spaceSignatures()
    expect(f.sleeps.at(-1)).toBe(50)
    f.advance(500)
    const before = f.sleeps.length
    await f.pace.spaceSignatures()
    expect(f.sleeps).toHaveLength(before)
  })
})

describe('IndexPace change tracking', () => {
  it('is due when never indexed, when the data changed, or when the sweep is due', () => {
    const { pace } = fakePace()
    expect(pace.due('m', 'h1', 60, 1_000)).toBe(true)
    pace.indexed('m', 'h1', 1_000)
    expect(pace.due('m', 'h1', 60, 1_005)).toBe(false)
    expect(pace.due('m', 'h2', 60, 1_005)).toBe(true)
    expect(pace.due('m', 'h1', 60, 1_059)).toBe(false)
    expect(pace.due('m', 'h1', 60, 1_060)).toBe(true)
    expect(pace.due('m', 'h1', 300, 1_299)).toBe(false)
    expect(pace.due('m', 'h1', 300, 1_300)).toBe(true)
    // Data not read this pass: only the sweep makes it due.
    expect(pace.due('m', undefined, 60, 1_005)).toBe(false)
    pace.forget('m')
    expect(pace.due('m', 'h1', 60, 1_005)).toBe(true)
  })

  it('orders by last index and drops markets no longer indexable', () => {
    const { pace } = fakePace()
    pace.indexed('a', 'x', 10)
    pace.indexed('b', 'x', 5)
    expect(pace.lastIndexedAt('b')).toBeLessThan(pace.lastIndexedAt('a'))
    expect(pace.lastIndexedAt('c')).toBe(Number.NEGATIVE_INFINITY)
    pace.retain(new Set(['a']))
    expect(pace.due('b', 'x', 60, 6)).toBe(true)
    expect(pace.due('a', 'x', 60, 11)).toBe(false)
  })
})
