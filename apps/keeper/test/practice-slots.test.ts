// R8: the Practice slots, 10, 12, 14, 16, 18 and 20:00 UTC, at most 6 a day.
import { describe, expect, it } from 'vitest'
import {
  dueSlot,
  nextSlots,
  PRACTICE_SLOT_GRACE_SECS,
  PRACTICE_SLOTS_UTC,
} from '../src/practice/slots'

const at = (iso: string) => Date.parse(iso) / 1000

describe('Practice slots', () => {
  it('starts every 2 h from 10:00 to 20:00 UTC, 6 a day', () => {
    expect(PRACTICE_SLOTS_UTC).toEqual([10, 12, 14, 16, 18, 20])
    expect(PRACTICE_SLOT_GRACE_SECS).toBe(600)
    const day = nextSlots(at('2026-12-06T00:00:00Z'), 6)
    expect(day.map((s) => new Date(s * 1000).toISOString())).toEqual([
      '2026-12-06T10:00:00.000Z',
      '2026-12-06T12:00:00.000Z',
      '2026-12-06T14:00:00.000Z',
      '2026-12-06T16:00:00.000Z',
      '2026-12-06T18:00:00.000Z',
      '2026-12-06T20:00:00.000Z',
    ])
  })

  it('has a slot due from its start for 10 min, and none between slots', () => {
    expect(dueSlot(at('2026-12-06T09:59:59Z'))).toBeNull()
    expect(dueSlot(at('2026-12-06T10:00:00Z'))).toBe(at('2026-12-06T10:00:00Z'))
    expect(dueSlot(at('2026-12-06T10:09:59Z'))).toBe(at('2026-12-06T10:00:00Z'))
    expect(dueSlot(at('2026-12-06T10:10:00Z'))).toBeNull()
    expect(dueSlot(at('2026-12-06T11:00:00Z'))).toBeNull()
    expect(dueSlot(at('2026-12-06T20:05:00Z'))).toBe(at('2026-12-06T20:00:00Z'))
    expect(dueSlot(at('2026-12-06T22:00:00Z'))).toBeNull()
  })

  it('lists the next slots strictly after now, across midnight', () => {
    expect(nextSlots(at('2026-12-06T10:00:00Z'), 1)).toEqual([at('2026-12-06T12:00:00Z')])
    expect(nextSlots(at('2026-12-06T20:30:00Z'), 2)).toEqual([
      at('2026-12-07T10:00:00Z'),
      at('2026-12-07T12:00:00Z'),
    ])
  })
})
