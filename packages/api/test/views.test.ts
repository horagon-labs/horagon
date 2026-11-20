import { describe, expect, it } from 'vitest'
import { etDayRange, etNextDay, etToday } from '../src/views'

describe('ET game dates', () => {
  it('maps an ET day to its UTC range, across both clock changes', () => {
    expect(etDayRange('2026-11-19')).toEqual({
      from: new Date('2026-11-19T05:00:00Z'),
      to: new Date('2026-11-20T05:00:00Z'),
    })
    // 2026-11-01: the clocks fall back, a 25-hour day.
    expect(etDayRange('2026-11-01')).toEqual({
      from: new Date('2026-11-01T04:00:00Z'),
      to: new Date('2026-11-02T05:00:00Z'),
    })
    // 2027-03-14: the clocks spring forward, a 23-hour day.
    expect(etDayRange('2027-03-14')).toEqual({
      from: new Date('2027-03-14T05:00:00Z'),
      to: new Date('2027-03-15T04:00:00Z'),
    })
  })

  it('dates a late tip-off on the evening it starts in ET', () => {
    // 22:30 ET on 19/11 is 03:30 UTC on 20/11: the NBA still dates it 19/11.
    expect(etToday(Date.parse('2026-11-20T03:30:00Z') / 1000)).toBe('2026-11-19')
    expect(etToday(Date.parse('2026-11-20T05:00:00Z') / 1000)).toBe('2026-11-20')
    expect(etNextDay('2026-12-31')).toBe('2027-01-01')
  })
})
