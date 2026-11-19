// The sampling rule behind `s4:compact --raw`: a game's raw lines are too many to commit, so keep
// the scoreboard lines around every change of game state, plus the detail lines (box score or
// summary) that were fetched next. The kept lines are then trimmed of third-party editorial,
// media and odds content, which has no place in the repo's history. Pure functions; the
// compactor does the streaming.

/** Keys removed, at any depth, from the body of every line of a raw sample. */
export const TRIMMED_KEYS = [
  'news',
  'article',
  'headlines',
  'videos',
  'highlights',
  'pickcenter',
  'againstTheSpread',
  'odds',
  'plays',
  'leaders',
  'injuries',
  'broadcasts',
  'geoBroadcasts',
  'tickets',
] as const

/** The part of a replay frame the sampling reads (a `ReplayFrame` fits). */
export interface SampleFrame {
  /** Timestamp of the scoreboard line that produced the frame. */
  t: string
  source: 'nba' | 'espn'
  status: string
  period: number
}

/** One recorded fetch of a game's detail URL, in recording order. */
export interface DetailLine {
  t: string
  /** False for a `{same: true}` record, an error or a null body. */
  hasBody: boolean
}

/**
 * The `t` of the scoreboard lines to keep, per source, in time order: the first and last frame
 * of the source, and for every frame whose (status, period) differs from the previous frame of
 * the same source, both that frame and the previous one.
 */
export function sampleScoreboardTimes(
  frames: readonly SampleFrame[],
): Record<SampleFrame['source'], string[]> {
  const kept: Record<SampleFrame['source'], Set<string>> = { nba: new Set(), espn: new Set() }
  const previous: Partial<Record<SampleFrame['source'], SampleFrame>> = {}
  for (const f of frames) {
    const prev = previous[f.source]
    if (!prev) kept[f.source].add(f.t)
    else if (prev.status !== f.status || prev.period !== f.period) {
      kept[f.source].add(prev.t)
      kept[f.source].add(f.t)
    }
    previous[f.source] = f
  }
  // `previous` now holds each source's last frame.
  for (const last of [previous.nba, previous.espn]) if (last) kept[last.source].add(last.t)
  return { nba: [...kept.nba].sort(), espn: [...kept.espn].sort() }
}

/**
 * Indexes into `details` (ascending) of the lines to keep: for each kept scoreboard time, the
 * first line with a body fetched at or after it, plus the last line with a body (the final
 * state). A line is listed once however many times it is picked.
 */
export function pickDetailLines(
  details: readonly DetailLine[],
  keptTimes: readonly string[],
): number[] {
  const picked = new Set<number>()
  for (const t of keptTimes) {
    const i = details.findIndex((d) => d.hasBody && d.t >= t)
    if (i >= 0) picked.add(i)
  }
  for (let i = details.length - 1; i >= 0; i--) {
    if (details[i]?.hasBody) {
      picked.add(i)
      break
    }
  }
  return [...picked].sort((a, b) => a - b)
}

const TRIMMED = new Set<string>(TRIMMED_KEYS)

/** A copy of `value` without the keys of `TRIMMED_KEYS`; the keys dropped are added to `removed`. */
function strip(value: unknown, removed: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => strip(v, removed))
  if (value === null || typeof value !== 'object') return value
  const kept: Array<[string, unknown]> = []
  for (const [key, v] of Object.entries(value)) {
    if (TRIMMED.has(key)) removed.add(key)
    else kept.push([key, strip(v, removed)])
  }
  return Object.fromEntries(kept)
}

/**
 * A recorder line with the `TRIMMED_KEYS` removed from its `body`, at any depth. A line that lost
 * keys gets a top-level `trimmed`: the sorted names of the keys dropped (a dropped value is not
 * searched, so a key inside one is not listed). Everything else is as recorded, and a line that
 * lost nothing (or has no body) comes back as it is, without `trimmed`.
 */
export function trimRecord(record: Record<string, unknown>): Record<string, unknown> {
  const removed = new Set<string>()
  const body = strip(record.body, removed)
  if (removed.size === 0) return record
  return { ...record, body, trimmed: [...removed].sort() }
}
