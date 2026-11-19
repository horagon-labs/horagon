import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { cdf, cdfInv, pdf } from '../../src/math/normal'

// Reference values: Python 3.14 statistics.NormalDist (independent implementation).
const CDF_CASES: Array<[number, number]> = [
  [-8, 6.220960574271819e-16],
  [-6, 9.865876450377014e-10],
  [-3, 0.0013498980316300959],
  [-2, 0.022750131948179216],
  [-1, 0.15865525393145707],
  [-0.5, 0.30853753872598694],
  [0, 0.5],
  [0.5, 0.691462461274013],
  [1, 0.8413447460685428],
  [2, 0.9772498680518209],
  [3, 0.9986501019683699],
  [6, 0.9999999990134123],
]

const INV_CASES: Array<[number, number]> = [
  [1e-10, -6.361340902404056],
  [0.001, -3.090232306167813],
  [0.01, -2.3263478740408408],
  [0.02425, -1.9729610513118845],
  [0.05, -1.6448536269514726],
  [0.1, -1.2815515655446008],
  [0.25, -0.6744897501960817],
  [0.5, 0],
  [0.75, 0.6744897501960817],
  [0.975, 1.9599639845400536],
  [0.99, 2.3263478740408408],
  [0.9999, 3.7190164854557084],
]

describe('pdf', () => {
  it('matches phi(0) and phi(1)', () => {
    expect(pdf(0)).toBeCloseTo(0.3989422804014327, 15)
    expect(pdf(1)).toBeCloseTo(0.24197072451914337, 15)
  })
})

describe('cdf', () => {
  it.each(CDF_CASES)('cdf(%d) matches the reference', (z, expected) => {
    expect(Math.abs(cdf(z) - expected) / expected).toBeLessThan(1e-12)
  })

  it('saturates far in the tails', () => {
    expect(cdf(-40)).toBe(0)
    expect(cdf(40)).toBe(1)
  })

  it('is symmetric: cdf(z) + cdf(-z) = 1', () => {
    fc.assert(
      fc.property(fc.double({ min: -10, max: 10, noNaN: true }), (z) => {
        expect(cdf(z) + cdf(-z)).toBeCloseTo(1, 14)
      }),
    )
  })
})

describe('cdfInv', () => {
  it.each(INV_CASES)('cdfInv(%d) matches the reference', (p, expected) => {
    expect(Math.abs(cdfInv(p) - expected)).toBeLessThanOrEqual(Math.abs(expected) * 1e-12)
  })

  it('inverts cdf across the full range, tails included', () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-12, max: 1 - 1e-12, noNaN: true }), (p) => {
        expect(Math.abs(cdf(cdfInv(p)) - p) / p).toBeLessThan(1e-11)
      }),
    )
  })

  it.each([0, 1, -0.1, 1.1, Number.NaN])('rejects p = %d', (p) => {
    expect(() => cdfInv(p)).toThrow(RangeError)
  })
})
