import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  computeSwapOutput,
  lEffective,
  priceFromReserves,
  reservesFromPrice,
  SWAP_DIRECTIONS,
  xyFromU,
} from '../../src/math/curve'
import { pdf } from '../../src/math/normal'

/** The pm-AMM invariant: (y-x)Phi((y-x)/L) + L*phi((y-x)/L) - y = 0. */
function invariant(x: number, y: number, l: number): number {
  const z = (y - x) / l
  const { y: yAtZ } = xyFromU(z, l)
  return yAtZ - y
}

describe('lEffective', () => {
  it('is L0 * sqrt(T - t)', () => {
    expect(lEffective(10, 3600)).toBeCloseTo(600, 12)
  })
  it.each([0, -1])('rejects time remaining %d', (t) => {
    expect(() => lEffective(10, t)).toThrow(RangeError)
  })
})

describe('reservesFromPrice / priceFromReserves', () => {
  // pm-AMM oracle (oracle/test_vectors.json, reserves.l_eff_1000), also Python NormalDist.
  it.each([
    [0.05, 1665.747, 20.893],
    [0.3, 714.773, 190.372],
    [0.5, 398.942, 398.942],
    [0.7, 190.372460387662, 714.772973095702],
    [0.95, 20.893, 1665.747],
  ])('P=%d gives the oracle reserves', (p, x, y) => {
    const r = reservesFromPrice(p, 1000)
    expect(r.x).toBeCloseTo(x, 2)
    expect(r.y).toBeCloseTo(y, 2)
  })

  it('round-trips the price', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.0001, max: 0.9999, noNaN: true }), (p) => {
        const r = reservesFromPrice(p, 1000)
        expect(priceFromReserves(r.x, r.y, 1000)).toBeCloseTo(p, 10)
      }),
    )
  })

  it('puts x = y = L*phi(0) at P = 0.5', () => {
    const r = reservesFromPrice(0.5, 1000)
    expect(r.x).toBeCloseTo(1000 * pdf(0), 9)
    expect(r.y).toBeCloseTo(1000 * pdf(0), 9)
  })

  it.each([0, 0.00009, 0.99991, 1])('rejects P = %d', (p) => {
    expect(() => reservesFromPrice(p, 1000)).toThrow(RangeError)
  })
})

describe('computeSwapOutput', () => {
  const l = 1000
  const start = reservesFromPrice(0.5, l)

  // pm-AMM oracle (oracle/test_vectors.json, swap.at_p_0.5), reproduced in Python to 6 places.
  it.each([
    [10, 19.842925, 0.507916],
    [50, 96.302962, 0.53836],
    [100, 186.207249, 0.573859],
    [200, 351.273339, 0.637308],
  ])('USDC->YES %d matches the oracle', (delta, out, price) => {
    const r = computeSwapOutput(start, l, delta, 'usdcToYes')
    expect(r.output).toBeCloseTo(out, 5)
    expect(r.priceNew).toBeCloseTo(price, 5)
  })

  it.each(SWAP_DIRECTIONS)('%s keeps the invariant and moves the price the right way', (d) => {
    const r = computeSwapOutput(start, l, 50, d)
    expect(r.output).toBeGreaterThan(0)
    expect(Math.abs(invariant(r.xNew, r.yNew, l))).toBeLessThan(1e-6)
    const yesUp = d === 'usdcToYes' || d === 'noToUsdc' || d === 'noToYes'
    if (yesUp) expect(r.priceNew).toBeGreaterThan(0.5)
    else expect(r.priceNew).toBeLessThan(0.5)
  })

  it('is symmetric at P = 0.5', () => {
    const yes = computeSwapOutput(start, l, 100, 'usdcToYes')
    const no = computeSwapOutput(start, l, 100, 'usdcToNo')
    expect(yes.output).toBeCloseTo(no.output, 9)
    expect(yes.priceNew + no.priceNew).toBeCloseTo(1, 12)
  })

  it('round-trips USDC->YES->USDC with no loss before fees', () => {
    const buy = computeSwapOutput(start, l, 10, 'usdcToYes')
    const sell = computeSwapOutput({ x: buy.xNew, y: buy.yNew }, l, buy.output, 'yesToUsdc')
    expect(sell.output).toBeCloseTo(10, 9)
  })

  it('never lowers the average price as the buy grows', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 500, noNaN: true }),
        fc.double({ min: 0.1, max: 500, noNaN: true }),
        (a, b) => {
          const [small, big] = a < b ? [a, b] : [b, a]
          const pSmall = small / computeSwapOutput(start, l, small, 'usdcToYes').output
          const pBig = big / computeSwapOutput(start, l, big, 'usdcToYes').output
          expect(pBig).toBeGreaterThanOrEqual(pSmall - 1e-12)
        },
      ),
    )
  })
})
