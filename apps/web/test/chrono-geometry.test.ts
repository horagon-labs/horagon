import { describe, expect, it } from 'vitest'
import {
  angleToPrice,
  arcPath,
  etClockAngle,
  FACE_SECS,
  MAX_ANGLE,
  MIN_ANGLE,
  nightAngle,
  polar,
  priceToAngle,
  timeLeftFraction,
} from '../lib/chrono/geometry'
import { etClock, etTime, spokenDuration } from '../lib/chrono/time'

const at = (iso: string) => Date.parse(iso) / 1000

describe('price <-> angle', () => {
  it('sweeps 270 degrees: 0 at 7:30, 50 at 12, 100 at 4:30', () => {
    expect(priceToAngle(0)).toBe(MIN_ANGLE)
    expect(priceToAngle(0.5)).toBe(0)
    expect(priceToAngle(1)).toBe(MAX_ANGLE)
    expect(priceToAngle(0.77)).toBeCloseTo(72.9, 6)
  })

  it('clamps out-of-range and non-finite prices instead of returning NaN', () => {
    expect(priceToAngle(-0.2)).toBe(MIN_ANGLE)
    expect(priceToAngle(1.4)).toBe(MAX_ANGLE)
    expect(priceToAngle(Number.NaN)).toBe(MIN_ANGLE)
  })

  it('angleToPrice inverts priceToAngle', () => {
    for (const p of [0, 0.1, 0.5, 0.77, 1]) expect(angleToPrice(priceToAngle(p))).toBeCloseTo(p, 9)
    expect(angleToPrice(-180)).toBe(0)
    expect(angleToPrice(180)).toBe(1)
  })
})

describe('polar and arcPath', () => {
  it('measures clockwise from 12 o’clock', () => {
    expect(polar(100, 100, 50, 0)).toEqual({ x: 100, y: 50 })
    expect(polar(100, 100, 50, 90)).toEqual({ x: 150, y: 100 })
    expect(polar(100, 100, 50, 180)).toEqual({ x: 100, y: 150 })
    expect(polar(100, 100, 50, -90)).toEqual({ x: 50, y: 100 })
  })

  it('draws clockwise arcs with the large-arc flag past 180 degrees', () => {
    expect(arcPath(100, 100, 50, 0, 90)).toBe('M 100 50 A 50 50 0 0 1 150 100')
    expect(arcPath(100, 100, 50, -135, 135)).toBe('M 64.645 135.355 A 50 50 0 1 1 135.355 135.355')
  })

  it('draws nothing for an empty sweep and stops just short of a full turn', () => {
    expect(arcPath(100, 100, 50, 10, 10)).toBe('')
    expect(arcPath(100, 100, 50, 10, 5)).toBe('')
    expect(arcPath(100, 100, 50, 0, 400)).toBe('M 100 50 A 50 50 0 1 1 99.991 50')
  })
})

describe('timeLeftFraction', () => {
  it('is the share of the interval still ahead, clamped to [0, 1]', () => {
    expect(timeLeftFraction(1_000, 2_000, 1_250)).toBe(0.75)
    expect(timeLeftFraction(1_000, 2_000, 500)).toBe(1)
    expect(timeLeftFraction(1_000, 2_000, 2_500)).toBe(0)
  })

  it('handles an empty or inverted interval', () => {
    expect(timeLeftFraction(2_000, 2_000, 1_000)).toBe(1)
    expect(timeLeftFraction(2_000, 1_000, 2_000)).toBe(0)
  })
})

describe('etClockAngle (Review Focus 4: midnight and the DST change)', () => {
  it('reads the ET wall clock on a 12-hour face', () => {
    // 2026-11-25 00:30 UTC is 7:30 PM EST.
    expect(etClockAngle(at('2026-11-25T00:30:00Z'))).toBe(225)
    expect(etClockAngle(at('2026-11-25T05:00:00Z'))).toBe(0)
    expect(etClockAngle(at('2026-11-25T08:15:00Z'))).toBe(97.5)
  })

  it('follows EDT before 2026-11-01 06:00 UTC and EST after', () => {
    expect(etClockAngle(at('2026-10-31T00:00:00Z'))).toBe(240) // 8:00 PM EDT
    expect(etClockAngle(at('2026-11-02T01:00:00Z'))).toBe(240) // 8:00 PM EST
    expect(etClockAngle(at('2026-11-01T05:30:00Z'))).toBe(45) // 1:30 AM EDT
    expect(etClockAngle(at('2026-11-01T06:30:00Z'))).toBe(45) // 1:30 AM EST, again
  })
})

describe('nightAngle', () => {
  const now = at('2026-11-01T03:00:00Z') // 11:00 PM EDT, three hours before the clocks change

  it('puts now on the ET hand and places every other second by real time', () => {
    expect(nightAngle(now, now)).toBe(330)
    expect(nightAngle(now + 3_600, now)).toBe(360) // midnight
    expect(nightAngle(now - 7_200, now)).toBe(270)
  })

  it('makes the window [now - 2 h, now + 10 h] exactly one turn across the DST change', () => {
    const start = nightAngle(now - 7_200, now)
    const end = nightAngle(now + 36_000, now)
    expect(end - start).toBe(360)
    expect(FACE_SECS).toBe(43_200)
  })
})

describe('ET times', () => {
  it('formats ET clock times and spoken durations', () => {
    expect(etTime(at('2026-11-25T02:08:00Z'))).toBe('9:08 PM')
    expect(etClock(at('2026-11-25T02:08:00Z'))).toBe('9:08 PM ET')
    expect(spokenDuration(3_720)).toBe('1 hour 2 minutes')
    expect(spokenDuration(3_600)).toBe('1 hour')
    expect(spokenDuration(7_260)).toBe('2 hours 1 minute')
    expect(spokenDuration(252)).toBe('4 minutes')
    expect(spokenDuration(45)).toBe('45 seconds')
    expect(spokenDuration(1)).toBe('1 second')
    expect(spokenDuration(-5)).toBe('0 seconds')
    expect(spokenDuration(Number.NaN)).toBe('0 seconds')
  })
})
