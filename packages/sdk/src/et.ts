// US Eastern (ET) game dates. An NBA game date is an ET calendar day; the offset (and the
// 23 or 25 hour days when the clocks change) comes from Intl, never from a fixed UTC offset.

const ET = 'America/New_York'
const etDate = new Intl.DateTimeFormat('en-CA', { timeZone: ET })
const etHour = new Intl.DateTimeFormat('en-US', { timeZone: ET, hour: 'numeric', hourCycle: 'h23' })

/** The calendar day after `date` (YYYY-MM-DD). */
export function etNextDay(date: string): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
}

/** 00:00 US Eastern time on `date`: 05:00 UTC in winter, 04:00 UTC in summer. */
function etMidnight(date: string): Date {
  const at = new Date(`${date}T05:00:00Z`)
  return new Date(at.getTime() - Number(etHour.format(at)) * 3_600_000)
}

/**
 * An NBA game date, a US Eastern (ET) calendar day, -> [start, end) in UTC. The day has 23 or
 * 25 hours when the clocks change.
 */
export function etDayRange(date: string): { from: Date; to: Date } {
  return { from: etMidnight(date), to: etMidnight(etNextDay(date)) }
}

/** The ET calendar day (YYYY-MM-DD) at `nowSecs`. */
export function etToday(nowSecs: number): string {
  return etDate.format(new Date(nowSecs * 1000))
}

/** Hours after midnight ET at which the night rolls over to the next ET date. */
export const NIGHT_ROLLOVER_HOURS = 6

/**
 * The night's ET date (YYYY-MM-DD) at `nowSecs`: the ET date of `now - 6 h`, so the night rolls
 * over at 06:00 ET and a late game stays on its own night until it has settled. The 6 h are real
 * hours, so on the two clock-change days the rollover is one hour off the wall clock.
 */
export function etNight(nowSecs: number): string {
  return etToday(nowSecs - NIGHT_ROLLOVER_HOURS * 3600)
}
