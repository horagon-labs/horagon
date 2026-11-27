import { describe, expect, it } from 'vitest'
import { lpLossSim, mulberry32 } from '../../src/study/lp-sim'

describe('mulberry32 (R10)', () => {
  it('is a seeded stream in [0, 1)', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    const xs = Array.from({ length: 5 }, () => a())
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs)
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true)
    expect(mulberry32(43)()).not.toBe(xs[0])
  })
})

describe('lpLossSim (R10)', () => {
  it('gives the same output for the same seed, and another for another seed', () => {
    const a = lpLossSim(7, 50)
    expect(lpLossSim(7, 50)).toEqual(a)
    expect(lpLossSim(8, 50).totalLoss).not.toBe(a.totalLoss)
    expect(a).toMatchObject({ seed: 7, paths: 50 })
  })

  it('reports each time bucket against the uniform-loss-rate prediction', () => {
    const r = lpLossSim(1, 20, { buckets: 4 })
    expect(r.buckets.map((b) => [b.from, b.to])).toEqual([
      [0, 0.25],
      [0.25, 0.5],
      [0.5, 0.75],
      [0.75, 1],
    ])
    // The paper: the dynamic pm-AMM loses half its starting value by T, at a uniform rate.
    for (const b of r.buckets) expect(b.predicted).toBeCloseTo(0.125, 12)
    expect(r.predictedTotal).toBe(0.5)
    expect(r.totalLoss).toBeCloseTo(
      r.buckets.reduce((a, b) => a + b.loss, 0),
      12,
    )
  })

  // Stated tolerance: at 400 paths every bucket's mean loss is within 15% of the prediction, and
  // the total within 5% of 0.5. The last bucket reads low and varies most: the price swings widest
  // near T, and the step that ends at T has no pool left to lose.
  it('is flat within the stated tolerance at a small N', () => {
    const r = lpLossSim(2026, 400)
    for (const b of r.buckets) {
      expect(Math.abs(b.loss / b.predicted - 1), `${b.from}-${b.to}`).toBeLessThan(0.15)
    }
    expect(Math.abs(r.totalLoss / 0.5 - 1)).toBeLessThan(0.05)
  })
})
