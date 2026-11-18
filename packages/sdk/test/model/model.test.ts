import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { HoragonError } from '../../src/errors'
import { eloCarryover, eloExpected, eloProbability, eloUpdate } from '../../src/model/elo'
import { winProbability } from '../../src/model/win-probability'

describe('Elo', () => {
  it('gives a 1600 home team vs 1500 a 0.7597 win probability (home advantage 100)', () => {
    expect(eloProbability(1600, 1500)).toBeCloseTo(0.759746927, 9)
  })

  it('clamps p0 to [0.05, 0.95]', () => {
    expect(eloProbability(2000, 1200)).toBe(0.95)
    expect(eloProbability(1200, 2000)).toBe(0.05)
  })

  it('moves 20 * (1 - 0.64) points after an even home win', () => {
    const r = eloUpdate(1500, 1500, true)
    expect(r.home).toBeCloseTo(1500 + 20 * (1 - eloExpected(1500, 1500)), 9)
    expect(r.home).toBeCloseTo(1507.19870000361, 6)
  })

  it('is zero-sum', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1000, max: 2000, noNaN: true }),
        fc.double({ min: 1000, max: 2000, noNaN: true }),
        fc.boolean(),
        (h, a, won) => {
          const r = eloUpdate(h, a, won)
          expect(r.home + r.away).toBeCloseTo(h + a, 9)
        },
      ),
    )
  })

  it('regresses 25% toward 1505 between seasons', () => {
    expect(eloCarryover(1600)).toBe(1576.25)
  })
})

describe('winProbability', () => {
  const sigma = 13

  it('equals p0 at tip-off with a tied score', () => {
    expect(winProbability({ margin: 0, minutesRemaining: 48, p0: 0.6, sigma })).toBeCloseTo(0.6, 12)
  })

  // Reference: Python statistics.NormalDist with the same formula.
  it('matches the reference for a lead late in the game', () => {
    expect(winProbability({ margin: 5, minutesRemaining: 12, p0: 0.5, sigma })).toBeCloseTo(
      0.779121836,
      9,
    )
    expect(winProbability({ margin: -3, minutesRemaining: 4.8, p0: 0.65, sigma })).toBeCloseTo(
      0.271624461,
      9,
    )
  })

  it('resolves to 1, 0 or 0.5 when no time is left', () => {
    expect(winProbability({ margin: 1, minutesRemaining: 0, p0: 0.3, sigma })).toBe(1)
    expect(winProbability({ margin: -1, minutesRemaining: 0, p0: 0.9, sigma })).toBe(0)
    expect(winProbability({ margin: 0, minutesRemaining: 0, p0: 0.9, sigma })).toBe(0.5)
  })

  it('treats overtime as minutes left in the period: a 2-point OT lead with 1 minute left', () => {
    const p = winProbability({ margin: 2, minutesRemaining: 1, p0: 0.5, sigma })
    expect(p).toBeGreaterThan(0.8)
    expect(p).toBeLessThan(1)
  })

  it('never decreases as the home margin grows', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -40, max: 40 }),
        fc.double({ min: 0.1, max: 48, noNaN: true }),
        fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        (margin, minutesRemaining, p0) => {
          const a = winProbability({ margin, minutesRemaining, p0, sigma })
          const b = winProbability({ margin: margin + 1, minutesRemaining, p0, sigma })
          expect(b).toBeGreaterThanOrEqual(a)
        },
      ),
    )
  })

  it.each([
    { margin: Number.NaN, minutesRemaining: 10, p0: 0.5, sigma },
    { margin: 0, minutesRemaining: -1, p0: 0.5, sigma },
    { margin: 0, minutesRemaining: 10, p0: 1, sigma },
    { margin: 0, minutesRemaining: 10, p0: 0.5, sigma: 0 },
  ])('rejects invalid input %o', (input) => {
    expect(() => winProbability(input)).toThrow(HoragonError)
  })
})
