import { describe, expect, it } from 'vitest'
import {
  BASELINE_BRIER,
  BASELINE_LOG_LOSS,
  brier,
  calibration,
  logLoss,
  reliabilityBins,
} from '../../src/study/calibration'
import { isUpset, UPSET_MAX_BPS, winnerOpened } from '../../src/study/upset'

const s = (p: number, homeWon: boolean) => ({ p, homeWon })

describe('brier and logLoss (R10)', () => {
  it('scores one forecast by hand: 0.7 that came true is 0.09 and 0.357', () => {
    expect(brier([s(0.7, true)])).toBeCloseTo(0.09, 12)
    expect(logLoss([s(0.7, true)])).toBeCloseTo(0.3567, 4)
    // The same forecast that did not come true.
    expect(brier([s(0.7, false)])).toBeCloseTo(0.49, 12)
    expect(logLoss([s(0.7, false)])).toBeCloseTo(-Math.log(0.3), 12)
  })

  it('averages over the sample, and is null on an empty one', () => {
    expect(brier([s(0.7, true), s(0.7, false)])).toBeCloseTo(0.29, 12)
    expect(brier([])).toBeNull()
    expect(logLoss([])).toBeNull()
  })

  it('gives the base rate exactly at 50%: 0.25 and ln 2', () => {
    expect(BASELINE_BRIER).toBe(0.25)
    expect(BASELINE_LOG_LOSS).toBe(Math.LN2)
    expect(brier([s(0.5, true), s(0.5, false)])).toBe(BASELINE_BRIER)
    expect(logLoss([s(0.5, false)])).toBeCloseTo(BASELINE_LOG_LOSS, 12)
  })

  it('stays finite at the edges', () => {
    expect(Number.isFinite(logLoss([s(1, false)]))).toBe(true)
    expect(Number.isFinite(logLoss([s(0, true)]))).toBe(true)
  })
})

describe('reliabilityBins (R10)', () => {
  it('folds every forecast to the favourite and counts five bins, 50-60 to 90-100', () => {
    const bins = reliabilityBins([
      s(0.55, true), // favourite home at 55%, won
      s(0.45, true), // favourite away at 55%, lost
      s(0.62, true),
      s(0.3, false), // favourite away at 70%, won
      s(0.95, true),
      s(0.5, false), // a coin flip: home is the favourite, lost
      s(1, true),
    ])
    expect(bins.map((b) => [b.from, b.to])).toEqual([
      [50, 60],
      [60, 70],
      [70, 80],
      [80, 90],
      [90, 100],
    ])
    expect(bins.map((b) => b.count)).toEqual([3, 1, 1, 0, 2])
    expect(bins[0]?.favouriteWon).toBe(1)
    expect(bins[0]?.meanForecast).toBeCloseTo((0.55 + 0.55 + 0.5) / 3, 12)
    expect(bins[2]?.favouriteWon).toBe(1)
    expect(bins[3]?.meanForecast).toBeNull()
    expect(bins[4]?.favouriteWon).toBe(2)
  })
})

describe('calibration (R10)', () => {
  it('reports N, both scores, both baselines, the bins and the upsets', () => {
    const c = calibration([s(0.7, true), s(0.26, true), s(0.6, false)])
    expect(c.n).toBe(3)
    expect(c.brier).toBeCloseTo((0.09 + 0.74 ** 2 + 0.36) / 3, 12)
    expect(c.baselineBrier).toBe(0.25)
    expect(c.baselineLogLoss).toBe(Math.LN2)
    expect(c.bins.reduce((a, b) => a + b.count, 0)).toBe(3)
    // Home won from 26%; away won from 40%: one upset.
    expect(c.upsets).toBe(1)
  })

  it('is empty but well formed with no games', () => {
    const c = calibration([])
    expect(c).toMatchObject({ n: 0, brier: null, logLoss: null, upsets: 0 })
    expect(c.bins).toHaveLength(5)
  })
})

describe('isUpset: the winner opened at 33% or less (R10)', () => {
  it('reads the winner side of the opening price', () => {
    expect(winnerOpened(2_600, true)).toBe(2_600)
    expect(winnerOpened(2_600, false)).toBe(7_400)
  })

  it('counts 3300 as an upset and 3301 not, on the home and away sides', () => {
    expect(UPSET_MAX_BPS).toBe(3_300)
    expect(isUpset(3_300, true)).toBe(true)
    expect(isUpset(3_301, true)).toBe(false)
    expect(isUpset(6_700, false)).toBe(true)
    expect(isUpset(6_699, false)).toBe(false)
  })
})
