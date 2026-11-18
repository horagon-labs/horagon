import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { HoragonError } from '../../src/errors'
import { SWAP_DIRECTIONS } from '../../src/math/curve'
import { feeOf } from '../../src/math/fees'
import { quoteSwap } from '../../src/math/quote'
import type { PoolState } from '../../src/math/rescale'

const NOW = 1_800_000_000

/** 100 mUSDC per side at P = 0.5 with one hour left: L_eff = 100e6 / phi(0). */
const POOL_A: PoolState = {
  lZero: 4177713.7910516676,
  reserveYes: 100_000_000,
  reserveNo: 100_000_000,
  lastAccrualTs: NOW,
  endTs: NOW + 3600,
  hasLiquidity: true,
  resolved: false,
}

/** Same depth as POOL_A, but with two hours left at the last accrual: the quote must rescale. */
const POOL_B: PoolState = {
  lZero: 2954089.7515091933,
  reserveYes: 100_000_000,
  reserveNo: 100_000_000,
  lastAccrualTs: NOW - 3600,
  endTs: NOW + 3600,
  hasLiquidity: true,
  resolved: false,
}

/** P = 0.7 with L_eff = 1e9 and one hour left. */
const POOL_C: PoolState = {
  lZero: 1e9 / 60,
  reserveYes: 190372460.38766155,
  reserveNo: 714772973.0957022,
  lastAccrualTs: NOW,
  endTs: NOW + 3600,
  hasLiquidity: true,
  resolved: false,
}

function expectRawNear(actual: bigint, expected: bigint): void {
  const diff = actual > expected ? actual - expected : expected - actual
  expect(diff <= 1n, `${actual} vs ${expected}`).toBe(true)
}

// Golden values: independent Python implementation (scratch golden_raw.py, statistics.NormalDist).
describe('quoteSwap golden values', () => {
  it.each([
    ['usdcToYes', POOL_A, 50_000_000n, 1_000_000n, 86_270_334n, 0.6346403430446587],
    ['usdcToNo', POOL_A, 50_000_000n, 1_000_000n, 86_270_334n, 0.36535965695534134],
    ['yesToUsdc', POOL_A, 50_000_000n, 460_342n, 22_556_791n, 0.42094710824946685],
    ['noToUsdc', POOL_A, 50_000_000n, 460_342n, 22_556_791n, 0.5790528917505331],
    ['yesToNo', POOL_A, 50_000_000n, 0n, 37_843_109n, 0.36300301658191425],
    ['noToYes', POOL_A, 50_000_000n, 0n, 37_843_109n, 0.6369969834180856],
    ['usdcToYes', POOL_B, 50_000_000n, 1_000_000n, 82_832_034n, 0.6798679980968694],
    ['usdcToNo', POOL_C, 25_000_000n, 500_000n, 78_086_363n, 0.6723148313922396],
    ['yesToUsdc', POOL_C, 40_000_000n, 554_398n, 27_165_530n, 0.6859491726836335],
  ] as const)(
    '%s on the reference pool',
    (direction, pool, amountIn, fee, amountOut, priceAfter) => {
      const q = quoteSwap({ pool, direction, amountIn, now: NOW })
      expectRawNear(q.fee, fee)
      expectRawNear(q.amountOut, amountOut)
      expect(q.priceAfter).toBeCloseTo(priceAfter, 9)
    },
  )

  it('reports price, average price, impact and min out for a buy', () => {
    const q = quoteSwap({ pool: POOL_A, direction: 'usdcToYes', amountIn: 50_000_000n, now: NOW })
    expect(q.priceBefore).toBeCloseTo(0.5, 12)
    expect(q.avgPrice).toBeCloseTo(50_000_000 / Number(q.amountOut), 12)
    expect(q.priceImpactBps).toBe(1346)
    expect(q.minOut).toBe((q.amountOut * 9800n) / 10_000n)
  })

  it('uses the given slippage for minOut', () => {
    const q = quoteSwap({
      pool: POOL_A,
      direction: 'usdcToYes',
      amountIn: 50_000_000n,
      now: NOW,
      slippageBps: 50,
    })
    expect(q.minOut).toBe((q.amountOut * 9950n) / 10_000n)
  })

  it('reports USDC per share as the average price of a sell', () => {
    const q = quoteSwap({ pool: POOL_A, direction: 'yesToUsdc', amountIn: 50_000_000n, now: NOW })
    expect(q.avgPrice).toBeCloseTo(Number(q.amountOut) / 50_000_000, 12)
  })
})

describe('quoteSwap errors', () => {
  function codeOf(fn: () => unknown): string | undefined {
    try {
      fn()
    } catch (e) {
      return e instanceof HoragonError ? e.code : 'not-a-HoragonError'
    }
    return undefined
  }

  it('rejects a resolved market', () => {
    const pool = { ...POOL_A, resolved: true }
    expect(
      codeOf(() => quoteSwap({ pool, direction: 'usdcToYes', amountIn: 1_000_000n, now: NOW })),
    ).toBe('MARKET_CLOSED')
  })

  it('rejects a market at or past end_ts', () => {
    expect(
      codeOf(() =>
        quoteSwap({ pool: POOL_A, direction: 'usdcToYes', amountIn: 1_000_000n, now: NOW + 3600 }),
      ),
    ).toBe('MARKET_CLOSED')
  })

  it('reports a halted market (all liquidity withdrawn) as MARKET_HALTED', () => {
    const pool = { ...POOL_A, lZero: 0, hasLiquidity: false }
    expect(
      codeOf(() => quoteSwap({ pool, direction: 'usdcToYes', amountIn: 1_000_000n, now: NOW })),
    ).toBe('MARKET_HALTED')
  })

  it.each([0n, -1n, 2n ** 53n])('rejects amountIn %s', (amountIn) => {
    expect(
      codeOf(() => quoteSwap({ pool: POOL_A, direction: 'usdcToYes', amountIn, now: NOW })),
    ).toBe('INVALID_INPUT')
  })

  it('rejects an amount whose output rounds to zero', () => {
    expect(
      codeOf(() => quoteSwap({ pool: POOL_A, direction: 'yesToUsdc', amountIn: 1n, now: NOW })),
    ).toBe('INVALID_INPUT')
  })

  it.each([-1, 10_001, 1.5])('rejects slippageBps %d', (slippageBps) => {
    expect(
      codeOf(() =>
        quoteSwap({
          pool: POOL_A,
          direction: 'usdcToYes',
          amountIn: 1_000_000n,
          now: NOW,
          slippageBps,
        }),
      ),
    ).toBe('INVALID_INPUT')
  })
})

describe('quoteSwap properties', () => {
  it('takes exactly 2% (floored) of the USDC input on buys', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 100n, max: 500_000_000n }), (amountIn) => {
        const q = quoteSwap({ pool: POOL_A, direction: 'usdcToNo', amountIn, now: NOW })
        expect(q.fee).toBe(feeOf(amountIn))
      }),
    )
  })

  it('never gives a better average price for a bigger buy', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1_000n, max: 400_000_000n }),
        fc.bigInt({ min: 1_000n, max: 400_000_000n }),
        (a, b) => {
          const [small, big] = a < b ? [a, b] : [b, a]
          const qs = quoteSwap({ pool: POOL_C, direction: 'usdcToYes', amountIn: small, now: NOW })
          const qb = quoteSwap({ pool: POOL_C, direction: 'usdcToYes', amountIn: big, now: NOW })
          // Flooring the fee and the output to raw units can move a tiny quote by 1-2 units.
          const rounding = 2 / Number(qs.amountOut) + 1 / Number(small)
          expect(qb.avgPrice).toBeGreaterThanOrEqual(qs.avgPrice * (1 - rounding))
        },
      ),
    )
  })

  it('never pays out more USDC than the shares sold', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1_000n, max: 1_000_000_000n }), (amountIn) => {
        const q = quoteSwap({ pool: POOL_C, direction: 'noToUsdc', amountIn, now: NOW })
        expect(q.amountOut <= amountIn).toBe(true)
      }),
    )
  })
})

// Review Focus: the last seconds of a game and orders far larger than the pool.
describe('quoteSwap at the edges of a game', () => {
  it.each(SWAP_DIRECTIONS)('%s one second before end_ts is finite and positive', (direction) => {
    const amountIn = direction.startsWith('usdc') ? 10_000_000n : 1_000_000n
    const q = quoteSwap({ pool: POOL_A, direction, amountIn, now: POOL_A.endTs - 1 })
    expect(q.amountOut > 0n).toBe(true)
    expect(Number.isFinite(q.priceAfter) && q.priceAfter >= 0 && q.priceAfter <= 1).toBe(true)
  })

  it('never quotes a whale buy above what the pool holds', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1_000n, max: 2n ** 53n - 1n }), (amountIn) => {
        const q = quoteSwap({ pool: POOL_A, direction: 'usdcToYes', amountIn, now: NOW })
        // A buy mints (amountIn - fee) pairs and takes YES from the pool: at most all of it.
        expect(q.amountOut <= amountIn - q.fee + BigInt(POOL_A.reserveYes)).toBe(true)
        expect(q.priceAfter >= q.priceBefore && q.priceAfter <= 1).toBe(true)
      }),
    )
  })

  it('never pays a dump more USDC than the opposite reserve', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1_000n, max: 2n ** 53n - 1n }), (amountIn) => {
        const q = quoteSwap({ pool: POOL_A, direction: 'yesToUsdc', amountIn, now: NOW })
        expect(q.amountOut <= BigInt(POOL_A.reserveNo)).toBe(true)
        expect(q.priceAfter <= q.priceBefore && q.priceAfter >= 0).toBe(true)
      }),
    )
  })
})
