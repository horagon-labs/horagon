// ESPN's public scoreboard, the keeper's only automated feed (the NBA CDN answers 403 to
// every host we tried, Tier 0 S4). The guardian's box-score check is the second source.
// Every raw payload is archived as NDJSON in the S4 recording format, so a night can be
// compacted into replay fixtures with `s4:compact`.
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Feed, FeedGame, FeedSnapshot, FeedStatus } from './types'

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

const easternDate = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d)

function points(score: string | undefined): number {
  const n = Number(score ?? '0')
  return Number.isInteger(n) && n >= 0 && n < 1000 ? n : 0
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
      homeScore: points(home.score),
      awayScore: points(away.score),
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
}

export class FeedError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export function espnFeed(opts: EspnFeedOptions = {}): Feed {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? (() => new Date())
  return {
    name: 'espn',
    async fetchDay(gameDate: string): Promise<FeedSnapshot> {
      const url = espnScoreboardUrl(gameDate)
      let res: Response
      try {
        res = await fetchImpl(url, {
          headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        })
      } catch (cause) {
        throw new FeedError(`espn: ${(cause as Error).name}`)
      }
      if (!res.ok) throw new FeedError(`espn answered ${res.status}`, res.status)
      const body: unknown = await res.json().catch(() => {
        throw new FeedError('espn: body is not JSON')
      })
      const fetchedAt = now()
      await opts.archive?.write(gameDate, url, body, fetchedAt)
      return { source: 'espn', url, fetchedAt, games: parseEspnScoreboard(body).games }
    },
  }
}
