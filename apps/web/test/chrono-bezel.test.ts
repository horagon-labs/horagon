import { describe, expect, it } from 'vitest'
import {
  angleToStep,
  buySteps,
  dragAngle,
  percentOf,
  pointerAngle,
  sellSteps,
  stepAngle,
  stepCrossed,
  stepIndex,
  wheelStep,
} from '../lib/chrono/bezel'

const amounts = (steps: { amount: string }[]) => steps.map((s) => s.amount)

describe('buySteps (spec 3.1)', () => {
  it('runs the whole ladder while the balance is unknown', () => {
    expect(amounts(buySteps(undefined))).toEqual(['1', '2', '5', '10', '25', '50', '100', '250'])
    expect(amounts(buySteps(null))).toHaveLength(8)
  })

  it('cuts the ladder at the balance and ends on the balance itself', () => {
    expect(amounts(buySteps('37.5'))).toEqual(['1', '2', '5', '10', '25', '37.5'])
    expect(amounts(buySteps('493.74'))).toEqual([
      '1',
      '2',
      '5',
      '10',
      '25',
      '50',
      '100',
      '250',
      '493.74',
    ])
    expect(buySteps('37.5').at(-1)?.text).toBe('37.5 mUSDC')
  })

  it('gives one step equal to a balance under the smallest step (Review Focus 2)', () => {
    expect(amounts(buySteps('0.5'))).toEqual(['0.5'])
    expect(amounts(buySteps('0.000001'))).toEqual(['0.000001'])
  })

  it('never repeats a step equal to the balance (Review Focus 2)', () => {
    expect(amounts(buySteps('25'))).toEqual(['1', '2', '5', '10', '25'])
    expect(amounts(buySteps('1'))).toEqual(['1'])
    expect(amounts(buySteps('250.000000'))).toEqual(['1', '2', '5', '10', '25', '50', '100', '250'])
  })

  it('has no step for an empty balance and the whole ladder for an unreadable one', () => {
    expect(buySteps('0')).toEqual([])
    expect(amounts(buySteps('lots'))).toHaveLength(8)
  })
})

describe('sellSteps (spec 3.1)', () => {
  it('offers 10, 25, 50, 75 and 100% of the shares', () => {
    expect(amounts(sellSteps('14.1'))).toEqual(['1.41', '3.525', '7.05', '10.575', '14.1'])
    expect(sellSteps('14.1')[2]?.text).toBe('50% · 7.05 shares')
  })

  it('rounds fractional shares down and never sells more than held (Review Focus 5)', () => {
    const steps = sellSteps('0.333333')
    expect(amounts(steps)).toEqual(['0.033333', '0.083333', '0.166666', '0.249999', '0.333333'])
    for (const s of steps) expect(Number(s.amount)).toBeLessThanOrEqual(0.333333)
  })

  it('takes a preset percentage the same way, and nothing of nothing', () => {
    expect(percentOf('14.1', 25)).toBe('3.525')
    expect(percentOf('0.333333', 50)).toBe('0.166666')
    expect(percentOf('14.1', 100)).toBe('14.1')
    expect(percentOf('0.000001', 25)).toBeNull()
    expect(percentOf(undefined, 50)).toBeNull()
  })

  it('drops steps that round to nothing or to a step already there', () => {
    expect(amounts(sellSteps('0.000003'))).toEqual(['0.000001', '0.000002', '0.000003'])
    expect(sellSteps('0')).toEqual([])
    expect(sellSteps(undefined)).toEqual([])
  })
})

describe('bezel angles (spec 3.1, 3.2)', () => {
  it('spreads the steps over the 270° arc and snaps back', () => {
    expect(stepAngle(0, 8)).toBe(-135)
    expect(stepAngle(7, 8)).toBe(135)
    expect(stepAngle(0, 1)).toBe(-135)
    expect(angleToStep(stepAngle(3, 8) + 10, 8)).toBe(3)
    expect(angleToStep(-500, 8)).toBe(0)
    expect(angleToStep(500, 8)).toBe(7)
  })

  it('reads the pointer clockwise from 12 o’clock', () => {
    expect(pointerAngle(100, 0, 100, 100)).toBe(0)
    expect(pointerAngle(200, 100, 100, 100)).toBe(90)
    expect(pointerAngle(0, 100, 100, 100)).toBe(-90)
  })

  it('clamps a drag across either end and never wraps around (Review Focus 3)', () => {
    // The steps an 8-step bezel shows for a drag sampled along its path.
    const drag = (start: number, path: number[]) => {
      let angle = start
      return path.map((raw) => {
        angle = dragAngle(angle, raw)
        return angleToStep(angle, 8)
      })
    }
    // Past the max end, through 6 o'clock and on round to 12 o'clock: it holds at max...
    expect(drag(130, [160, 175, -170, -140, -90, -40, 0])).toEqual([7, 7, 7, 7, 7, 7, 7])
    // ...and moves again only once it comes back the same way.
    expect(drag(360, [-40, -140, 175, 100])).toEqual([7, 7, 7, 6])
    // The same from the min end.
    expect(drag(-130, [-160, -175, 170, 140, 90, 40, 0])).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(drag(-360, [40, 140, -175, -100])).toEqual([0, 0, 0, 1])
    // The angle is unwrapped, never clamped: angleToStep does the clamping.
    expect(dragAngle(135, -170)).toBe(190)
    expect(dragAngle(-135, 170)).toBe(-190)
    expect(dragAngle(135, 100)).toBe(100)
  })

  it('finds the step for an amount and says when a step was crossed', () => {
    const steps = buySteps('37.5')
    expect(stepIndex(steps, '25')).toBe(4)
    expect(stepIndex(steps, '30')).toBe(4)
    expect(stepIndex(steps, '0.1')).toBe(0)
    expect(stepIndex(steps, 'abc')).toBe(0)
    expect(stepCrossed(2, 3)).toBe(true)
    expect(stepCrossed(3, 3)).toBe(false)
    expect(wheelStep(-120)).toBe(1)
    expect(wheelStep(40)).toBe(-1)
    expect(wheelStep(0)).toBe(0)
  })
})
