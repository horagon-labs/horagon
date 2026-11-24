// The Tape's pure parts (spec 3.2, 5.4): chart times as unix seconds for the ET axis, prices
// for its price axis, where each quarter starts, and one marker per scoring run from runs.ts.
import type { GameHistory } from '@horagon/sdk'
import type { Time } from 'lightweight-charts'
import { cents } from '../format'
import type { Run } from './runs'
import { COLORS } from './tokens'

/** Below this distance from 0 or 1, a chart price is float noise from the axis arithmetic. */
const NOISE = 1e-9

/**
 * A price on the axis or the crosshair: held to 0-100¢, so a crosshair above the range reads
 * 100¢ and the bottom tick 0¢. "<1¢" and ">99¢" stay for real prices just inside the edges.
 */
export function tapeCents(p: number): string {
  const clamped = Math.min(1, Math.max(0, p))
  if (clamped < NOISE) return cents(0)
  if (clamped > 1 - NOISE) return cents(1)
  return cents(clamped)
}

/** Unix seconds of a chart time; the Tape only ever sets UTCTimestamp, the rest is for types. */
export function tapeTime(t: Time): number {
  if (typeof t === 'number') return t
  if (typeof t === 'string') return Math.floor(Date.parse(t) / 1000)
  return Date.UTC(t.year, t.month - 1, t.day) / 1000
}

export const periodLabel = (p: number): string => (p <= 4 ? `Q${p}` : p === 5 ? 'OT' : `${p - 4}OT`)

export interface PeriodStart {
  ts: number
  period: number
  label: string
}

/** The first snapshot of each new period after the first one seen: a dashed line each. */
export function periodStarts(snapshots: GameHistory['snapshots']): PeriodStart[] {
  const out: PeriodStart[] = []
  let last: number | null = null
  for (const s of [...snapshots].sort((a, b) => a.ts - b.ts)) {
    if (last !== null && s.period > last) {
      out.push({ ts: s.ts, period: s.period, label: periodLabel(s.period) })
    }
    last = s.period
  }
  return out
}

export interface TapeMarker {
  time: number
  position: 'aboveBar'
  shape: 'circle'
  color: string
  text: string
}

/**
 * One marker per run, at its last basket, in its side's color: "CLE 8–0". Markers sit on the
 * model line, which has a point at every snapshot with a model price; a run whose end has no
 * such point is left out rather than misplaced.
 */
export function runMarkers(
  runs: readonly Run[],
  teams: { home: string; away: string },
  times: ReadonlySet<number>,
): TapeMarker[] {
  return runs
    .filter((r) => times.has(r.to))
    .map((r) => ({
      time: r.to,
      position: 'aboveBar',
      shape: 'circle',
      color: r.team === 'home' ? COLORS['lume-300'] : COLORS['brass-500'],
      text: `${teams[r.team]} ${r.points}–0`,
    }))
}
