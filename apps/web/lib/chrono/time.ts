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

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

/** "1 hour 2 minutes", "4 minutes", "45 seconds": for aria labels (spec 2.6). */
export function spokenDuration(secs: number): string {
  const s = Math.max(0, Math.floor(secs))
  if (s < 60) return plural(s, 'second')
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h === 0) return plural(m, 'minute')
  return m === 0 ? plural(h, 'hour') : `${plural(h, 'hour')} ${plural(m, 'minute')}`
}
