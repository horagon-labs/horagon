// The Night dial's arcs (spec 3.1, 4.1): each game's interval on the 12-hour face, packed into
// at most 8 rings, cut into its pre-open, past and future parts, and the few that get a label.
import type { Game, MarketSummary } from '@horagon/sdk'
import { nightAngle, polar } from './geometry'
import { type DialState, isTrading } from './state'

/** The market opens 60 min before tip-off (as the game cards said). */
export const PRE_OPEN_SECS = 3_600
/**
 * The arc's close before a market exists: tip-off + 3 h, the end_ts the keeper sets (its
 * endOffsetSecs, 10,800 since R1), so the arc does not jump when the market is created. The
 * market closes at the final buzzer before that.
 */
export const EST_LENGTH_SECS = 10_800
/** The face shows [now - 2 h, now + 10 h]: exactly 12 hours, one turn. */
export const WINDOW_BEFORE_SECS = 7_200
export const WINDOW_AFTER_SECS = 36_000
export const MAX_RINGS = 8
/** Ring 0 is the outermost; each next ring sits 7 units further in (viewBox 0 0 200 200). */
export const RING_OUTER = 86
export const RING_STEP = 7
export const CENTER = 100

export interface Interval {
  /** Unix seconds: market open (or tip-off - 60 min), tip-off, close (end_ts or estimate). */
  start: number
  tip: number
  end: number
}

export function gameInterval(
  game: Pick<Game, 'scheduledTipoff'>,
  market: Pick<MarketSummary, 'endTs'> | undefined,
): Interval {
  const tip = Math.floor(Date.parse(game.scheduledTipoff) / 1000)
  return { start: tip - PRE_OPEN_SECS, tip, end: market ? market.endTs : tip + EST_LENGTH_SECS }
}

export interface NightWindow {
  from: number
  to: number
}

export const nightWindow = (now: number): NightWindow => ({
  from: now - WINDOW_BEFORE_SECS,
  to: now + WINDOW_AFTER_SECS,
})

export interface Placeable {
  id: string
  interval: Interval
  /** The game's dial state, when known: a game that stopped trading never takes the centre. */
  state?: DialState
}

export interface Track<T extends Placeable> {
  item: T
  ring: number
  /** The interval cut to the window. */
  from: number
  to: number
}

export interface Packed<T extends Placeable> {
  tracks: Track<T>[]
  /** In the window but past the 8th ring: shown in the list only, counted as "+N". */
  overflow: T[]
}

/**
 * Greedy rings: sorted by start, each game takes the first ring whose last arc has ended
 * (touching is fine). A game wholly outside the window is in neither list.
 */
export function packTracks<T extends Placeable>(items: readonly T[], now: number): Packed<T> {
  const w = nightWindow(now)
  const ends: number[] = []
  const tracks: Track<T>[] = []
  const overflow: T[] = []
  const inside = items
    .filter((i) => i.interval.end > w.from && i.interval.start < w.to)
    .sort((a, b) => a.interval.start - b.interval.start || a.interval.end - b.interval.end)
  for (const item of inside) {
    let ring = ends.findIndex((end) => end <= item.interval.start)
    if (ring === -1 && ends.length < MAX_RINGS) ring = ends.length
    if (ring === -1) {
      overflow.push(item)
      continue
    }
    ends[ring] = item.interval.end
    tracks.push({
      item,
      ring,
      from: Math.max(item.interval.start, w.from),
      to: Math.min(item.interval.end, w.to),
    })
  }
  return { tracks, overflow }
}

export const ringRadius = (ring: number): number => RING_OUTER - ring * RING_STEP

export interface Segment {
  from: number
  to: number
  /** Before tip-off: the hour the market is open before the game (drawn dashed). */
  pre: boolean
  /** Before the now hand (drawn dim). */
  past: boolean
}

/** A track cut at tip-off and at now. */
export function segments(track: Track<Placeable>, now: number): Segment[] {
  const { tip } = track.item.interval
  const cuts = [...new Set([track.from, tip, now, track.to])]
    .filter((t) => t >= track.from && t <= track.to)
    .sort((a, b) => a - b)
  const out: Segment[] = []
  for (let i = 0; i + 1 < cuts.length; i++) {
    const from = cuts[i] as number
    const to = cuts[i + 1] as number
    out.push({ from, to, pre: to <= tip, past: to <= now })
  }
  return out
}

/** The arc angles of a segment: start angle and end angle, end > start. */
export const segmentAngles = (s: Pick<Segment, 'from' | 'to'>, now: number) => ({
  from: nightAngle(s.from, now),
  to: nightAngle(s.to, now),
})

/**
 * Labels stay few (spec 3.1): the selected arc, the hovered or focused one, and the one that
 * closes soonest, in that order, without repeats. The first is the Night dial's centre.
 *
 * "Closes soonest" counts only games that still trade (`isTrading`): a game halted at the final
 * buzzer, or closed, or waiting for or holding its result, never holds the centre while another
 * still trades; with none trading, the soonest end_ts ahead stands. A stopped game's arc still
 * runs to its end_ts: the summary carries no halt time to end it at.
 */
export function labelIds(
  tracks: readonly Track<Placeable>[],
  opts: { selectedId: string | null; hoverId: string | null; now: number },
): string[] {
  const placed = new Set(tracks.map((t) => t.item.id))
  const ahead = tracks
    .filter((t) => t.item.interval.end > opts.now)
    .sort((a, b) => a.item.interval.end - b.item.interval.end)
  const next = ahead.find((t) => t.item.state === undefined || isTrading(t.item.state)) ?? ahead[0]
  const ids = [opts.selectedId, opts.hoverId, next?.item.id ?? null]
  return [...new Set(ids.filter((id): id is string => id !== null && placed.has(id)))]
}

export interface LabelSpot {
  id: string
  x: number
  y: number
  anchor: 'start' | 'middle' | 'end'
}

/** Where each label goes: just inside its arc's end, skipped when it would sit on another. */
export function labelSpots(
  tracks: readonly Track<Placeable>[],
  ids: readonly string[],
  now: number,
): LabelSpot[] {
  const spots: LabelSpot[] = []
  for (const id of ids) {
    const t = tracks.find((x) => x.item.id === id)
    if (!t) continue
    const p = polar(CENTER, CENTER, ringRadius(t.ring) - 6, nightAngle(t.to, now))
    if (spots.some((s) => Math.hypot(s.x - p.x, s.y - p.y) < 10)) continue
    const anchor = p.x < CENTER - 8 ? 'start' : p.x > CENTER + 8 ? 'end' : 'middle'
    spots.push({ id, x: p.x, y: p.y, anchor })
  }
  return spots
}
