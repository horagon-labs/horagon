import { describe, expect, it } from 'vitest'
import { lEffective, reservesFromPrice } from '../../src/math/curve'
import { quoteSwap } from '../../src/math/quote'
import {
  DEPTH_BUYS_USDC,
  depthCurve,
  END_OFFSET_BEFORE_R1_SECS,
  END_OFFSET_SECS,
  lZeroAtHalf,
  MEDIAN_FINAL_MINUTES,
} from '../../src/study/depth'

const now3h = depthCurve({ endOffsetSecs: END_OFFSET_SECS })
const before = depthCurve({ endOffsetSecs: END_OFFSET_BEFORE_R1_SECS })

describe('depthCurve (R10)', () => {
  it('covers both end_ts offsets: S+3h00m today and S+2h10m before R1', () => {
    expect(END_OFFSET_SECS).toBe(10_800)
    expect(END_OFFSET_BEFORE_R1_SECS).toBe(7_800)
    expect(DEPTH_BUYS_USDC).toEqual([10, 100])
    expect(now3h.points[0]?.minute).toBe(0)
    expect(now3h.points.at(-1)?.minute).toBeLessThan(180)
    expect(before.points.at(-1)?.minute).toBeLessThan(130)
    expect(MEDIAN_FINAL_MINUTES).toBeCloseTo(151.6, 6)
  })

  it('agrees with quoteSwap on a 50% pool at the same minute', () => {
    const lZero = lZeroAtHalf(300, 3_600 + END_OFFSET_SECS)
    for (const p of [now3h.points[0], now3h.points[12], now3h.points[30]]) {
      if (!p) throw new Error('missing point')
      const t = p.minute * 60
      const r = reservesFromPrice(0.5, lEffective(lZero, END_OFFSET_SECS - t))
      const pool = {
        lZero,
        reserveYes: r.x,
        reserveNo: r.y,
        lastAccrualTs: t,
        endTs: END_OFFSET_SECS,
        hasLiquidity: true,
        resolved: false,
      }
      for (const [usdc, move] of [
        [10, p.move10],
        [100, p.move100],
      ] as const) {
        const q = quoteSwap({ pool, direction: 'usdcToYes', amountIn: BigInt(usdc * 1e6), now: t })
        expect(move, `${usdc} at ${p.minute}`).toBeCloseTo(q.priceAfter - q.priceBefore, 12)
      }
    }
  })

  it('thins as time runs out: the move only grows with the minute', () => {
    for (const curve of [now3h, before]) {
      const pts = curve.points.filter((p) => p.move100 !== null)
      for (let i = 1; i < pts.length; i++) {
        const [a, b] = [pts[i - 1], pts[i]]
        if (!a || !b) continue
        expect(b.move10).toBeGreaterThan(a.move10 as number)
        expect(b.move100).toBeGreaterThan(a.move100 as number)
        expect(b.depthShare).toBeLessThan(a.depthShare)
      }
    }
  })

  it('is thinner at S+2h10m than at S+3h00m at the same minute', () => {
    for (const p of before.points) {
      const q = now3h.points.find((x) => x.minute === p.minute)
      if (!q || p.move10 === null || q.move10 === null) continue
      expect(p.move10, `minute ${p.minute}`).toBeGreaterThan(q.move10)
      expect(p.depthShare).toBeLessThan(q.depthShare)
    }
  })

  it('opens with the whole seed at create: depth share 1 at minute -60', () => {
    // Created 60 min before tip-off, so at tip-off sqrt(180 / 240) of the opening depth is left.
    expect(now3h.points[0]?.depthShare).toBeCloseTo(Math.sqrt(180 / 240), 12)
  })
})
