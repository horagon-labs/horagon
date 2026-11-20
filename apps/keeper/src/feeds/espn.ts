// ESPN's public scoreboard, the keeper's only automated feed (the NBA CDN answers 403 to
// every host we tried, Tier 0 S4). The guardian's box-score check is the second source.
// Every raw payload is archived as NDJSON in the S4 recording format, so a night can be
// compacted into replay fixtures with `s4:compact`.
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { errorSummary } from '@horagon/sdk'
import { z } from 'zod'
import { easternDate, type Feed, type FeedGame, type FeedSnapshot, type FeedStatus } from './types'

export const ESPN_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'
export const espnScoreboardUrl = (gameDate: string) =>
  `${ESPN_SCOREBOARD_URL}?dates=${gameDate.replaceAll('-', '')}`
export const USER_AGENT = 'horagon-keeper/0.1'

/** ESPN abbreviations that differ from NBA tricodes. */
const TRICODE: Readonly<Record<string, string>> = {
  GS: 'GSW',
  NY: 'NYK',
  NO: 'NOP',
  SA: 'SAS',
  UTAH: 'UTA',
  WSH: 'WAS',
}
export const nbaTricode = (abbreviation: string) => TRICODE[abbreviation] ?? abbreviation

const Competitor = z.object({
  homeAway: z.enum(['home', 'away']),
  score: z.string().optional(),
  linescores: z.array(z.object({ value: z.number() })).optional(),
  team: z.object({ abbreviation: z.string().regex(/^[A-Z]{2,4}$/) }),
})
const Event = z.object({
  id: z.string().regex(/^\d{1,16}$/),
  date: z.string(),
  competitions: z
    .array(
      z.object({
        notes: z.array(z.object({ headline: z.string().optional() })).optional(),
        status: z.object({
          clock: z.number().optional(),
          period: z.number().int().min(0),
          type: z.object({
            name: z.string(),
            state: z.enum(['pre', 'in', 'post']),
            completed: z.boolean(),
          }),
        }),
        competitors: z.array(Competitor).length(2),
      }),
    )
    .min(1),
})

/**
 * ESPN marks a postponed game `post` without `completed`: only `post` AND `completed` is
 * final (Tier 0 review). Postponed and canceled are read from the status name first.
 */
export function espnStatus(type: { name: string; state: string; completed: boolean }): FeedStatus {
  // A delayed tip-off stays 'pre' (scheduled); only postponed or suspended halts the market.
  if (/POSTPONED|SUSPENDED/.test(type.name)) return 'postponed'
  if (/CANCEL/.test(type.name)) return 'canceled'
  if (type.state === 'in') return 'live'
  if (type.state === 'pre') return 'scheduled'
  return type.completed ? 'final' : 'postponed'
}

/**
 * A score as a whole number, or null when it is unreadable. ESPN sends "0" for both sides
 * before tip-off (checked in the recording). Scores only matter for live and final games, so a
 * missing score reads 0 for the other statuses (a postponed or canceled game must keep its
 * status); a score that is present but malformed is always unreadable.
 */
function points(score: string | undefined, optional: boolean): number | null {
  if (score === undefined) return optional ? 0 : null
  if (!/^\d{1,3}$/.test(score)) return null
  return Number(score)
}

export interface ParseResult {
  games: FeedGame[]
  /** Events skipped because they did not match the expected shape. */
  skipped: number
}

/** Parse a scoreboard body. A malformed event is skipped and counted, never thrown. */
export function parseEspnScoreboard(body: unknown): ParseResult {
  const events = (body as { events?: unknown })?.events
  if (!Array.isArray(events)) return { games: [], skipped: 0 }
  const games: FeedGame[] = []
  let skipped = 0
  for (const raw of events) {
    const parsed = Event.safeParse(raw)
    if (!parsed.success) {
      skipped++
      continue
    }
    const e = parsed.data
    const c = e.competitions[0]
    const home = c?.competitors.find((t) => t.homeAway === 'home')
    const away = c?.competitors.find((t) => t.homeAway === 'away')
    const tipoff = new Date(e.date)
    if (!c || !home || !away || Number.isNaN(tipoff.getTime())) {
      skipped++
      continue
    }
    const status = espnStatus(c.status.type)
    const scoreOptional = status !== 'live' && status !== 'final'
    const homeScore = points(home.score, scoreOptional)
    const awayScore = points(away.score, scoreOptional)
    if (homeScore === null || awayScore === null) {
      skipped++
      continue
    }
    const hl = home.linescores ?? []
    const al = away.linescores ?? []
    const periods: Array<[number, number]> = []
    for (let i = 0; i < Math.max(hl.length, al.length); i++) {
      periods.push([Math.round(hl[i]?.value ?? 0), Math.round(al[i]?.value ?? 0)])
    }
    games.push({
      league: 'NBA',
      externalId: e.id,
      gameDate: easternDate(tipoff),
      home: nbaTricode(home.team.abbreviation),
      away: nbaTricode(away.team.abbreviation),
      tipoff,
      status,
      period: c.status.period,
      clockSecs: status === 'live' ? Math.max(0, Math.round(c.status.clock ?? 0)) : null,
      homeScore,
      awayScore,
      periods,
      cup: (c.notes ?? []).some((n) => /\bcup\b/i.test(n.headline ?? '')),
    })
  }
  return { games, skipped }
}

/**
 * Appends raw payloads to `<dir>/<gameDate>.ndjson`, one `{t, src: 'espn-scoreboard', url, body}`
 * per line, as the S4 recorder writes them, so `s4:compact` turns a night into replay fixtures.
 */
export class RawArchive {
  constructor(private readonly dir: string) {}

  async write(gameDate: string, url: string, body: unknown, at: Date): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const line = JSON.stringify({ t: at.toISOString(), src: 'espn-scoreboard', url, body })
    await appendFile(join(this.dir, `${gameDate}.ndjson`), `${line}\n`)
  }
}

export interface EspnFeedOptions {
  fetchImpl?: typeof fetch
  archive?: RawArchive
  timeoutMs?: number
  now?: () => Date
  /** Called when the raw archive cannot be written; the snapshot is still returned. */
  onArchiveError?: (cause: unknown) => void
}

export class FeedError extends Error {
  readonly status?: number
  constructor(message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'FeedError'
    this.status = opts.status
  }
}

const GAME_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertGameDate(gameDate: string): void {
  const ms = GAME_DATE.test(gameDate) ? Date.parse(`${gameDate}T00:00:00Z`) : Number.NaN
  const real = !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(gameDate)
  if (!real) throw new FeedError('espn: gameDate must be a real YYYY-MM-DD date')
}

/**
 * ESPN's scoreboard as a feed. Errors are FeedError with a fixed message (never the response
 * body) and the original error as `cause`. A failed archive write does not lose the snapshot:
 * it is returned and the failure goes to `opts.onArchiveError`, or by default to one
 * `console.warn` line (message only, never the URL or the body).
 */
export function espnFeed(opts: EspnFeedOptions = {}): Feed {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? (() => new Date())
  return {
    name: 'espn',
    async fetchDay(gameDate: string): Promise<FeedSnapshot> {
      assertGameDate(gameDate)
      const url = espnScoreboardUrl(gameDate)
      let res: Response
      try {
        res = await fetchImpl(url, {
          headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        })
      } catch (cause) {
        const name = (cause as Error | undefined)?.name
        const timeout = name === 'TimeoutError' || name === 'AbortError'
        throw new FeedError(timeout ? 'espn: request timed out' : 'espn: network error', {
          cause,
        })
      }
      if (!res.ok) throw new FeedError(`espn answered ${res.status}`, { status: res.status })
      let body: unknown
      try {
        body = await res.json()
      } catch (cause) {
        const name = (cause as Error | undefined)?.name
        const timeout = name === 'TimeoutError' || name === 'AbortError'
        throw new FeedError(timeout ? 'espn: request timed out' : 'espn: body is not JSON', {
          cause,
        })
      }
      const fetchedAt = now()
      try {
        await opts.archive?.write(gameDate, url, body, fetchedAt)
      } catch (cause) {
        if (opts.onArchiveError) opts.onArchiveError(cause)
        else console.warn(`espn: archive write failed: ${errorSummary(cause).message}`)
      }
      const { games, skipped } = parseEspnScoreboard(body)
      return { source: 'espn', url, fetchedAt, games, skipped }
    },
  }
}
