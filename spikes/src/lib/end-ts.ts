import { join } from 'node:path'

// When should a winner market close? Game timelines from ESPN play-by-play (each play carries a
// wallclock), measured against S, the scheduled tip-off ESPN lists for the game.

/** One play: [wallclock ms, period, clock seconds left in the period, home, away, End Game 1|0]. */
export type Play = [number, number, number, number, number, 0 | 1]

export interface GameTimeline {
  /** ESPN event id. */
  id: string
  /** ESPN game date, YYYYMMDD (US Eastern). */
  date: string
  /** Scheduled tip-off, ISO 8601, as ESPN lists it (e.g. "2026-11-19T00:00Z"). */
  scheduled: string
  /** "AWAY @ HOME". */
  name: string
  /** 4 for regulation, 5 or more after overtime. */
  periods: number
  /** Plays with a wallclock, in ESPN's order. */
  plays: Play[]
}

export interface GameStats {
  id: string
  date: string
  name: string
  overtime: boolean
  /** Minutes from S to the first play (the opening tip). */
  tipMin: number
  /** Minutes from S to the End Game play (or the last play). */
  endMin: number
  /** Minutes from S to the first play of Q4, or null if the timeline never reaches it. */
  q4StartMin: number | null
  /** Home minus away at the end. */
  finalMargin: number
}

export interface OffsetStats {
  /** The close, in minutes after S. */
  offsetMin: number
  /** Games whose End Game came at or before the close. */
  endedBeforeClose: number
  /** Share of games that had reached Q4, overtime or the end at the close. */
  closeInQ4OrLaterPct: number
  /** Median minutes of Q4 game clock played before the close (12 once Q4 is over). */
  q4GameMinTradableMedian: number
  /** Median share of regulation game clock played before the close, in percent. */
  gameTradableMedianPct: number
  /** Games within 5 points with 1:00 or less left in Q4, or in overtime, while still open. */
  clutchOpen: number
  /** Median wall minutes from the start of Q4 to the close or the end, whichever comes first (0 if Q4 starts after the close). */
  q4WallMinBeforeCloseMedian: number
  /** P(end before close), pairing every tip delay with every tip-to-end length. */
  pairedEndBeforeClosePct: number
}

/** Fetched game timelines (spikes/data, committed). */
export const DATA_DIR = join(import.meta.dirname, '../../data')

const MIN = 60_000
const QUARTER_SECS = 720

/** "11:54" or "0.0" (ESPN shows tenths under a minute) to seconds. */
export function clockSecs(display: string | undefined): number {
  const s = display ?? '0'
  if (!s.includes(':')) return Number(s)
  const [m, sec] = s.split(':')
  return Number(m) * 60 + Number(sec)
}

export const scheduledMs = (g: GameTimeline): number => Date.parse(g.scheduled)

/** The End Game play, or the last play when ESPN has none. */
export function endPlay(g: GameTimeline): Play {
  const last = g.plays.at(-1)
  if (!last) throw new Error(`${g.id}: no plays`)
  return g.plays.find((p) => p[5] === 1) ?? last
}

/**
 * The last play in ESPN's order stamped at or before `ms`, or null before the first play. ESPN's
 * order follows the game, but its wallclocks do not always: a few plays carry a stamp minutes
 * late (MEM @ GS on 2026-10-23 has end-of-Q1 plays stamped after the final), so every play is
 * scanned instead of stopping at the first one after `ms`.
 */
export function stateAt(g: GameTimeline, ms: number): Play | null {
  let state: Play | null = null
  for (const p of g.plays) if (p[0] <= ms) state = p
  return state
}

/** ESPN stamps some games of a DST change day an hour early; such a timeline starts before S. */
export const startsBeforeSchedule = (g: GameTimeline): boolean =>
  (g.plays[0]?.[0] ?? Number.POSITIVE_INFINITY) < scheduledMs(g)

/** Wallclock of the first play of Q4 or later, in ESPN's order. */
const q4StartMs = (g: GameTimeline): number | undefined => g.plays.find((p) => p[1] >= 4)?.[0]

export function gameStats(g: GameTimeline): GameStats {
  const s = scheduledMs(g)
  const end = endPlay(g)
  const first = g.plays[0] as Play
  const q4 = q4StartMs(g)
  return {
    id: g.id,
    date: g.date,
    name: g.name,
    overtime: g.periods > 4,
    tipMin: (first[0] - s) / MIN,
    endMin: (end[0] - s) / MIN,
    q4StartMin: q4 === undefined ? null : (q4 - s) / MIN,
    finalMargin: end[3] - end[4],
  }
}

/** Value at quantile q of a sorted copy, by linear interpolation. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo)
}

const isClutch = (p: Play) => ((p[1] === 4 && p[2] <= 60) || p[1] > 4) && Math.abs(p[3] - p[4]) <= 5

export function offsetStats(games: readonly GameTimeline[], offsetMin: number): OffsetStats {
  let ended = 0
  let inQ4 = 0
  let clutch = 0
  const q4Minutes: number[] = []
  const tradable: number[] = []
  const q4Wall: number[] = []
  for (const g of games) {
    const close = scheduledMs(g) + offsetMin * MIN
    const end = endPlay(g)[0]
    const q4Start = q4StartMs(g)
    q4Wall.push(q4Start === undefined ? 0 : Math.max(0, Math.min(close, end) - q4Start) / MIN)
    if (g.plays.some((p) => p[0] <= close && p[0] < end && isClutch(p))) clutch++
    if (end <= close) {
      ended++
      inQ4++
      q4Minutes.push(12)
      tradable.push(1)
      continue
    }
    const s = stateAt(g, close)
    const period = s?.[1] ?? 0
    const clock = s?.[2] ?? QUARTER_SECS
    if (period >= 4) inQ4++
    q4Minutes.push(period === 4 ? (QUARTER_SECS - clock) / 60 : period > 4 ? 12 : 0)
    const left =
      period === 0
        ? 4 * QUARTER_SECS
        : period >= 4
          ? period === 4
            ? clock
            : 0
          : (4 - period) * QUARTER_SECS + clock
    tradable.push(1 - left / (4 * QUARTER_SECS))
  }
  const stats = games.map(gameStats)
  const lengths = stats.map((x) => x.endMin - x.tipMin)
  let paired = 0
  for (const x of stats) for (const len of lengths) if (x.tipMin + len <= offsetMin) paired++
  return {
    offsetMin,
    endedBeforeClose: ended,
    closeInQ4OrLaterPct: (100 * inQ4) / games.length,
    q4GameMinTradableMedian: quantile(q4Minutes, 0.5),
    gameTradableMedianPct: 100 * quantile(tradable, 0.5),
    clutchOpen: clutch,
    q4WallMinBeforeCloseMedian: quantile(q4Wall, 0.5),
    pairedEndBeforeClosePct: (100 * paired) / (stats.length * lengths.length),
  }
}

/** The first play with this much Q4 clock left or less, as [minutes after S, home - away]. */
export function q4Mark(g: GameTimeline, clockSecs: number): [number, number] | null {
  const p = g.plays.find((x) => x[1] === 4 && x[2] <= clockSecs)
  return p ? [(p[0] - scheduledMs(g)) / MIN, p[3] - p[4]] : null
}
