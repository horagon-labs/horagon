// Times in words and on the ET clock (spec 5.4): every time on screen is ET, with "ET".
const CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
})

/** "9:08 PM" in ET for unix second `ts`; add " ET" where it stands alone. */
export const etTime = (ts: number): string => CLOCK.format(new Date(ts * 1000))

/** "9:08 PM ET". */
export const etClock = (ts: number): string => `${etTime(ts)} ET`

const DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const DAY_LABEL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
})

/** "2026-11-27": the ET day of unix second `ts`, as the NBA (and the API's `date`) dates games. */
export const etDay = (ts: number): string => DAY.format(new Date(ts * 1000))

/** "Fri, Nov 27": the ET day of unix second `ts`, for people. */
export const etDayLabel = (ts: number): string => DAY_LABEL.format(new Date(ts * 1000))

const WEEKDAY = {
  short: new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }),
  long: new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }),
}

/** "Sat" or "Saturday": the ET weekday of unix second `ts`. */
export const etWeekday = (ts: number, style: 'short' | 'long' = 'short'): string =>
  WEEKDAY[style].format(new Date(ts * 1000))

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

/** "1 hour 2 minutes", "4 minutes", "45 seconds": for aria labels (spec 2.6). */
export function spokenDuration(secs: number): string {
  const s = Number.isFinite(secs) ? Math.max(0, Math.floor(secs)) : 0
  if (s < 60) return plural(s, 'second')
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h === 0) return plural(m, 'minute')
  return m === 0 ? plural(h, 'hour') : `${plural(h, 'hour')} ${plural(m, 'minute')}`
}

/** "in 47 min", "in 2 h 5 min", "in 3 h": exact to the minute (R8, shared by the board). */
export function inMinutes(secs: number): string {
  const m = Math.max(1, Math.ceil(secs / 60))
  if (m < 60) return `in ${m} min`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `in ${h} h` : `in ${h} h ${m % 60} min`
}

/** "in 15 h" in whole hours from 2 h up, "in 42 min" below (first-screen spec C19). */
export function roughIn(secs: number): string {
  const m = Math.max(1, Math.ceil(secs / 60))
  // Seconds short of 2 h count as 2 h, never "120 min".
  return m >= 120 ? `in ${Math.round(secs / 3_600)} h` : `in ${m} min`
}
