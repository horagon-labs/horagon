import { describe, expect, it } from 'vitest'
import { lEffective, priceFromReserves, reservesFromPrice } from '../../src/math/curve'
import { type PoolState, rescaleReserves } from '../../src/math/rescale'

const WEEK = 86_400 * 7

function pool(price: number, lZero: number, endTs: number, lastAccrualTs: number): PoolState {
  const r = reservesFromPrice(price, lEffective(lZero, endTs - lastAccrualTs))
  return {
    lZero,
    reserveYes: r.x,
    reserveNo: r.y,
    lastAccrualTs,
    endTs,
    hasLiquidity: true,
    resolved: false,
  }
}

describe('rescaleReserves', () => {
  // pm-AMM accrual.rs oracle tests: L0 = 10, 7-day market, accrue after 1 day.
  it('releases 230.145 YES and NO at P = 0.5 after one day', () => {
    const p = pool(0.5, 10, WEEK, 0)
    const r = rescaleReserves(p, 86_400)
    expect(p.reserveYes - r.x).toBeCloseTo(230.14534860553158, 8)
    expect(p.reserveNo - r.y).toBeCloseTo(230.14534860553158, 8)
  })

  it('releases 412.34 YES and 109.82 NO at P = 0.3 after one day', () => {
    const p = pool(0.3, 10, WEEK, 0)
    const r = rescaleReserves(p, 86_400)
    expect(p.reserveYes - r.x).toBeCloseTo(412.34454994690986, 7)
    expect(p.reserveNo - r.y).toBeCloseTo(109.82374747726476, 7)
  })

  it('keeps the price', () => {
    for (const price of [0.05, 0.2, 0.5, 0.8, 0.95]) {
      const p = pool(price, 10, WEEK, 0)
      const r = rescaleReserves(p, 86_400)
      expect(priceFromReserves(r.x, r.y, lEffective(10, WEEK - 86_400))).toBeCloseTo(price, 10)
    }
  })

  it('halves sqrt-wise: 7200 s left to 3600 s left scales reserves by 1/sqrt(2)', () => {
    const lZero = 100e6 / 0.3989422804014327 / Math.sqrt(7200)
    const p = pool(0.5, lZero, 7200, 0)
    const r = rescaleReserves(p, 3600)
    expect(r.x).toBeCloseTo(70710678.11865476, 4)
    expect(r.y).toBeCloseTo(70710678.11865476, 4)
  })

  it('releases everything at or after end_ts', () => {
    const p = pool(0.5, 10, WEEK, 0)
    expect(rescaleReserves(p, WEEK)).toEqual({ x: 0, y: 0 })
    expect(rescaleReserves(p, WEEK + 999)).toEqual({ x: 0, y: 0 })
  })

  it('is a no-op when time has not moved, when resolved, or without liquidity', () => {
    const p = pool(0.5, 10, WEEK, 1000)
    const same = { x: p.reserveYes, y: p.reserveNo }
    expect(rescaleReserves(p, 1000)).toEqual(same)
    expect(rescaleReserves(p, 999)).toEqual(same)
    expect(rescaleReserves({ ...p, resolved: true }, 5000)).toEqual(same)
    expect(rescaleReserves({ ...p, hasLiquidity: false }, 5000)).toEqual(same)
    expect(rescaleReserves({ ...p, lZero: 0 }, 5000)).toEqual(same)
  })

  it('clamps an extreme price instead of throwing', () => {
    const p: PoolState = {
      lZero: 10,
      reserveYes: 0,
      reserveNo: 100_000,
      lastAccrualTs: 0,
      endTs: WEEK,
      hasLiquidity: true,
      resolved: false,
    }
    const r = rescaleReserves(p, 86_400)
    expect(priceFromReserves(r.x, r.y, lEffective(10, WEEK - 86_400))).toBeCloseTo(0.9999, 10)
  })
})
