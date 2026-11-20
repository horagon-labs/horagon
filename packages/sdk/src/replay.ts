// Recorded games for replay: spike S4 writes them (`tests/fixtures/replay/`, one file per game),
// the keeper's replay mode reads them, and the Tier 2 sandbox will too. Every reader must accept
// what the 2026-11-18 recording holds:
// - frames before tip-off carry period 0 (and clock "0.0");
// - clocks are "M:SS" above a minute and "S.S" below it; the NBA CDN writes "PT5M30.00S";
// - ESPN scores can go down within a game (stat corrections);
// - about an hour after the final whistle the clock can reset to "12:00" while the status
//   stays final;
// - `tipoffUtc` may leave out the seconds ("2026-11-19T01:00Z").
import { z } from 'zod'

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z$/

/** Date.parse rolls impossible dates over (Feb 30, 24:00), so compare the fields back. */
function isRealUtcTime(s: string): boolean {
  const ms = Date.parse(s)
  if (Number.isNaN(ms)) return false
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s)
  if (!m) return false
  const d = new Date(ms)
  return (
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() + 1 === Number(m[2]) &&
    d.getUTCDate() === Number(m[3]) &&
    d.getUTCHours() === Number(m[4]) &&
    d.getUTCMinutes() === Number(m[5])
  )
}

/** An ISO time in UTC, with or without seconds, normalised to `Date#toISOString`. */
const UtcTimeSchema = z
  .string()
  .regex(ISO_UTC, 'must be an ISO time in UTC')
  .refine(isRealUtcTime, 'must be a real date and time')
  .transform((s) => new Date(s).toISOString())

export const ReplayFrameSchema = z.object({
  t: UtcTimeSchema,
  source: z.enum(['nba', 'espn']),
  status: z.enum(['pre', 'live', 'final', 'postponed']),
  period: z.number().int().min(0),
  clock: z.string(),
  homeScore: z.number().int().min(0),
  awayScore: z.number().int().min(0),
  /** v1 only: [home, away] per period. v0 readers rebuild it from score changes. */
  periods: z.array(z.tuple([z.number().int(), z.number().int()])).optional(),
})

export const ReplayGameSchema = z.object({
  schema: z.enum(['horagon.replay.v0', 'horagon.replay.v1']),
  /** Game date in US Eastern time, as the NBA schedules it. */
  gameDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  home: z.string().regex(/^[A-Z]{2,4}$/),
  away: z.string().regex(/^[A-Z]{2,4}$/),
  /** Scheduled tip-off. */
  tipoffUtc: UtcTimeSchema,
  nbaGameId: z.string().optional(),
  espnEventId: z.string().optional(),
  frames: z.array(ReplayFrameSchema).min(1),
})

/** One recorded change of status, period, clock or score. */
export type ReplayFrame = z.infer<typeof ReplayFrameSchema>
/** The fixture format: what `ReplayGameSchema` parses to. */
export type ReplayGame = z.infer<typeof ReplayGameSchema>
/** What a writer produces before parsing (the compactor's output). */
export type ReplayGameInput = z.input<typeof ReplayGameSchema>

/** "11:16", "45.3", "0.0" (ESPN) or "PT11M16.00S" (NBA) to whole seconds; 0 when unreadable. */
export function clockToSecs(clock: string): number {
  const iso = /^PT(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(clock)
  if (iso) {
    const secs = Math.round(Number(iso[1] ?? 0) * 60 + Number(iso[2] ?? 0))
    return Number.isFinite(secs) ? secs : 0
  }
  const mmss = /^(\d+):(\d{2})$/.exec(clock)
  if (mmss) {
    const secs = Number(mmss[1]) * 60 + Number(mmss[2])
    return Number.isFinite(secs) ? secs : 0
  }
  const secs = Number(clock)
  return Number.isFinite(secs) && secs >= 0 ? Math.round(secs) : 0
}
