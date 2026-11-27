import type { Logger } from 'pino'
import { describe, expect, it } from 'vitest'
import {
  BACKOFF,
  backoffDelayMs,
  IndexPace,
  isRateLimited,
  MarketMarks,
  SIGNATURES_SPACING_MS,
  TRANSACTION_CHUNK,
  TRANSACTION_SPACING_MS,
  TRANSACTIONS_PER_WINDOW,
} from '../src/index-pace'

/** A pace on a fake clock: `sleep` moves the clock, `random` is fixed unless given. */
function fakePace(o: { random?: () => number } = {}) {
  let t = 1_000_000
  const warns: Array<{ obj: Record<string, unknown>; msg: string }> = []
  const sleeps: number[] = []
  const pace = new IndexPace({
    log: {
      warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }),
      debug: () => {},
      info: () => {},
    } as unknown as Logger,
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
  it('holds reads for the delay after a failure, logging once with the delay', async () => {
    const f = fakePace()
    expect(f.pace.held()).toBe(false)
    const delay = f.pace.down('index', new Error('429 Too Many Requests'))
    expect(delay).toBe(30_000)
    expect(f.warns).toHaveLength(1)
    expect(f.warns[0]?.obj).toMatchObject({ source: 'index', delayMs: 30_000 })
    expect(f.pace.held()).toBe(true)
    f.advance(29_999)
    expect(f.pace.held()).toBe(true)
    f.advance(1)
    expect(f.pace.held()).toBe(false)
    // Held passes log nothing more.
    expect(f.warns).toHaveLength(1)
  })

  it('grows the delay on each failure in a row and resets after a clean pass', async () => {
    const f = fakePace()
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      delays.push(f.pace.down('index', new Error('429')))
      f.advance(delays.at(-1) ?? 0)
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000])
    f.pace.clean()
    expect(f.pace.down('index', new Error('429'))).toBe(30_000)
  })

  it('applies the jitter it is given', async () => {
    const f = fakePace({ random: () => 0.5 })
    expect(f.pace.down('index', new Error('429'))).toBe(
      Math.round(30_000 * (1 - BACKOFF.jitter * 0.5)),
    )
  })
})

describe('IndexPace read spacing', () => {
  /** The most calls at times `at` (ms) that fall in any window of `windowMs`. */
  const busiest = (at: number[], windowMs: number) =>
    Math.max(...at.map((t0) => at.filter((t) => t >= t0 && t < t0 + windowMs).length))

  it('spaces signature reads SIGNATURES_SPACING_MS apart on the clock', async () => {
    const f = fakePace()
    const at: number[] = []
    for (let i = 0; i < 4; i++) {
      await f.pace.spaceSignatures()
      at.push(f.now())
    }
    const gaps = at.slice(1).map((t, i) => t - (at[i] ?? 0))
    expect(gaps).toEqual([350, 350, 350])
    expect(SIGNATURES_SPACING_MS).toBe(350)
    // Time already gone by counts.
    f.advance(150)
    await f.pace.spaceSignatures()
    expect(f.sleeps.at(-1)).toBe(200)
    f.advance(500)
    const before = f.sleeps.length
    await f.pace.spaceSignatures()
    expect(f.sleeps).toHaveLength(before)
  })

  it('keeps any 10 s window to 30 signature reads, under the public 40 per 10 s per method', async () => {
    const f = fakePace()
    const at: number[] = []
    for (let i = 0; i < 120; i++) {
      await f.pace.spaceSignatures()
      at.push(f.now())
    }
    expect(busiest(at, 10_000)).toBeLessThanOrEqual(30)
  })

  it('caps a wait at one spacing after the clock steps back', async () => {
    const f = fakePace()
    await f.pace.spaceSignatures()
    f.advance(-3_600_000)
    await f.pace.spaceSignatures()
    expect(f.sleeps.at(-1)).toBeLessThanOrEqual(SIGNATURES_SPACING_MS)
  })
})

describe('IndexPace transaction budget', () => {
  /** The most entries at times `at` (ms, with a count each) in any window of `windowMs`. */
  const busiest = (at: Array<{ t: number; n: number }>, windowMs: number) =>
    Math.max(
      ...at.map(({ t: t0 }) =>
        at.filter(({ t }) => t >= t0 && t < t0 + windowMs).reduce((s, x) => s + x.n, 0),
      ),
    )

  it('spends 350 ms of its clock per entry, waiting no longer than it is given', async () => {
    const f = fakePace()
    expect(TRANSACTION_SPACING_MS).toBe(350)
    expect(TRANSACTION_CHUNK).toBe(10)
    // A signature read does not touch it: the RPC counts each method apart.
    await f.pace.spaceSignatures()
    expect(await f.pace.takeTransactions(10, 0)).toBe(true)
    expect(f.sleeps).toEqual([])
    // Ten entries cost 3.5 s: not within 1 s, nothing taken.
    expect(await f.pace.takeTransactions(10, 1_000)).toBe(false)
    expect(f.sleeps).toEqual([])
    expect(await f.pace.takeTransactions(2, 3_500)).toBe(true)
    expect(f.sleeps).toEqual([3_500])
    expect(await f.pace.takeTransactions(1, Number.POSITIVE_INFINITY)).toBe(true)
    expect(f.sleeps).toEqual([3_500, 700])
  })

  it('keeps any 10 s window to 30 entries, whatever the batch sizes, indexer and ATA watch together', async () => {
    expect(TRANSACTIONS_PER_WINDOW).toBe(30)
    for (const sizes of [[10], [1, 10, 10, 10], [3, 7, 1, 10, 2], [1]]) {
      const f = fakePace()
      const at: Array<{ t: number; n: number }> = []
      for (let i = 0; i < 60; i++) {
        const n = sizes[i % sizes.length] ?? 1
        expect(await f.pace.takeTransactions(n, Number.POSITIVE_INFINITY)).toBe(true)
        at.push({ t: f.now(), n })
      }
      expect(busiest(at, 10_000)).toBeLessThanOrEqual(30)
    }
  })

  it('does not wait for hours after the clock steps back', async () => {
    const f = fakePace()
    await f.pace.takeTransactions(10, 0)
    f.advance(-3_600_000)
    expect(await f.pace.takeTransactions(10, 10_000)).toBe(true)
    expect(Math.max(0, ...f.sleeps)).toBeLessThanOrEqual(10_000)
  })
})

describe('MarketMarks', () => {
  it('is due when never indexed, when the data changed, or when the sweep is due', () => {
    const pace = new MarketMarks()
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

  it('keeps a market read in part due on every pass, behind the ones that waited longer', () => {
    const marks = new MarketMarks()
    marks.indexed('a', 'x', 10)
    marks.partial('b', 20)
    expect(marks.due('b', 'y', 60, 21)).toBe(true)
    expect(marks.due('b', undefined, 60, 21)).toBe(true)
    expect(marks.lastIndexedAt('a')).toBeLessThan(marks.lastIndexedAt('b'))
    marks.indexed('b', 'y', 25)
    expect(marks.due('b', 'y', 60, 30)).toBe(false)
  })

  it('keeps the slot of each cursor through forget, never lower, until the market is dropped', () => {
    const marks = new MarketMarks()
    expect(marks.cursorSlot('m')).toBeUndefined()
    marks.cursorAt('m', 12)
    marks.cursorAt('m', 11)
    expect(marks.cursorSlot('m')).toBe(12)
    marks.forget('m')
    expect(marks.cursorSlot('m')).toBe(12)
    marks.cursorAt('m', 13)
    expect(marks.cursorSlot('m')).toBe(13)
    marks.retain(new Set(['other']))
    expect(marks.cursorSlot('m')).toBeUndefined()
  })

  it('is seeded once after a start, and a written cursor goes past the seed', () => {
    const marks = new MarketMarks()
    expect(marks.needsCursorSlot('m')).toBe(true)
    marks.seedCursorSlot('m', 20)
    marks.seedCursorSlot('m', 30)
    expect(marks.needsCursorSlot('m')).toBe(false)
    expect(marks.cursorSlot('m')).toBe(20)
    marks.cursorAt('m', 25)
    expect(marks.cursorSlot('m')).toBe(25)
    // No trade: nothing known, and not asked again.
    marks.seedCursorSlot('n', null)
    expect(marks.needsCursorSlot('n')).toBe(false)
    expect(marks.cursorSlot('n')).toBeUndefined()
    marks.cursorAt('n', 3)
    expect(marks.cursorSlot('n')).toBe(3)
    marks.retain(new Set())
    expect(marks.needsCursorSlot('n')).toBe(true)
  })

  it('orders by last index and drops markets no longer indexable', () => {
    const pace = new MarketMarks()
    pace.indexed('a', 'x', 10)
    pace.indexed('b', 'x', 5)
    expect(pace.lastIndexedAt('b')).toBeLessThan(pace.lastIndexedAt('a'))
    expect(pace.lastIndexedAt('c')).toBe(Number.NEGATIVE_INFINITY)
    pace.retain(new Set(['a']))
    expect(pace.due('b', 'x', 60, 6)).toBe(true)
    expect(pace.due('a', 'x', 60, 11)).toBe(false)
  })
})
