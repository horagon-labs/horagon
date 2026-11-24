// Dial geometry (spec 3.1). Angles are degrees clockwise from 12 o'clock, so an SVG
// `rotate(a cx cy)` turns a needle drawn pointing up to angle `a`.

/** The price scale sweeps 270 degrees: 0 at 7:30, 0.5 at 12, 1 at 4:30. */
export const MIN_ANGLE = -135
export const MAX_ANGLE = 135
export const SWEEP = MAX_ANGLE - MIN_ANGLE

/** Seconds in the 12 hours of a clock face. */
export const FACE_SECS = 43_200

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)
const round3 = (n: number) => Math.round(n * 1000) / 1000

export function priceToAngle(price: number): number {
  return MIN_ANGLE + clamp01(price) * SWEEP
}

export function angleToPrice(angle: number): number {
  return clamp01((angle - MIN_ANGLE) / SWEEP)
}

export interface Point {
  x: number
  y: number
}

/** The point `r` away from (cx, cy) at `angle`, rounded to 0.001 so markup stays stable. */
export function polar(cx: number, cy: number, r: number, angle: number): Point {
  const rad = (angle * Math.PI) / 180
  return { x: round3(cx + r * Math.sin(rad)), y: round3(cy - r * Math.cos(rad)) }
}

/**
 * The `d` of a clockwise arc from `from` to `to` degrees. A sweep of a full turn or more is
 * drawn just short of it (an SVG arc cannot end where it starts); none draws nothing.
 */
export function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const sweep = Math.min(to - from, 359.99)
  if (!(sweep > 0)) return ''
  const a = polar(cx, cy, r, from)
  const b = polar(cx, cy, r, from + sweep)
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${b.x} ${b.y}`
}

/** The share of [startTs, endTs] still ahead of `now`, in [0, 1]. */
export function timeLeftFraction(startTs: number, endTs: number, now: number): number {
  if (endTs <= startTs) return now < endTs ? 1 : 0
  return clamp01((endTs - now) / (endTs - startTs))
}

const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
})

/** Where the ET wall clock at unix second `ts` points on a 12-hour face (DST included). */
export function etClockAngle(ts: number): number {
  const parts = ET.formatToParts(new Date(ts * 1000))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0)
  const secs = (part('hour') % 12) * 3600 + part('minute') * 60 + part('second')
  return (secs / FACE_SECS) * 360
}

/**
 * The Night dial's angle for `ts`: the now hand sits at the ET clock time of `now`, and every
 * other moment is placed by real seconds from it. The 12-hour window is then exactly one turn,
 * so arcs never overlap, even on a night the clocks change (spec 4.1).
 */
export function nightAngle(ts: number, now: number): number {
  return etClockAngle(now) + ((ts - now) / FACE_SECS) * 360
}
