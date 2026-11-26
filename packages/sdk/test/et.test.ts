import { describe, expect, it } from 'vitest'
import { etDayRange, etNextDay, etNight, etToday } from '../src/et'

const secs = (iso: string) => Date.parse(iso) / 1000

describe('etNight: the night rolls over at 06:00 ET', () => {
  it('stays on the evening date at 05:59 ET and moves on at 06:00 ET (EST)', () => {
    expect(etNight(secs('2026-11-28T10:59:59Z'))).toBe('2026-11-27')
    expect(etNight(secs('2026-11-28T11:00:00Z'))).toBe('2026-11-28')
    // 00:30 ET, still the night of the 27th
    expect(etNight(secs('2026-11-28T05:30:00Z'))).toBe('2026-11-27')
  })

  it('does the same in summer time (EDT)', () => {
    expect(etNight(secs('2026-07-15T09:59:59Z'))).toBe('2026-07-14')
    expect(etNight(secs('2026-07-15T10:00:00Z'))).toBe('2026-07-15')
  })

  it('follows the clock change: spring forward on 2027-03-14', () => {
    // The 6 h are real hours: 10:59:59Z less 6 h is 04:59:59Z, 23:59 EST on the 13th; 11:00Z
    // (07:00 EDT) less 6 h is 05:00Z, 00:00 EST on the 14th.
    expect(etNight(secs('2027-03-14T10:59:59Z'))).toBe('2027-03-13')
    expect(etNight(secs('2027-03-14T11:00:00Z'))).toBe('2027-03-14')
    expect(etToday(secs('2027-03-14T05:00:00Z'))).toBe('2027-03-14')
  })

  it('follows the clock change: fall back on 2026-11-01', () => {
    // 10:00Z less 6 h is 04:00Z, 00:00 EDT: the rollover is at 05:00 EST that day.
    expect(etNight(secs('2026-11-01T09:59:59Z'))).toBe('2026-10-31')
    expect(etNight(secs('2026-11-01T10:00:00Z'))).toBe('2026-11-01')
  })

  it('reads a 03:00Z tip-off (10:00 PM ET) as inside the range of its own night', () => {
    const night = etNight(secs('2026-11-28T05:30:00Z'))
    const { from } = etDayRange(night)
    const to = etDayRange(etNextDay(night)).to
    const tip = new Date('2026-11-28T03:00:00Z')
    expect(tip >= from && tip < to).toBe(true)
    expect(from).toEqual(new Date('2026-11-27T05:00:00Z'))
    // at 06:30 ET the range starts at 00:00 ET of that day
    expect(etDayRange(etNight(secs('2026-11-28T11:30:00Z'))).from).toEqual(
      new Date('2026-11-28T05:00:00Z'),
    )
  })
})
