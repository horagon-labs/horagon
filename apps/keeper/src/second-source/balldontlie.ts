// balldontlie (free tier: an API key, 5 requests a minute): the keeper's second source of NBA
// scores, which checks the ESPN draft before the attestor proposes it (R6). Ported from Plan B's
// watcher client. One request per ET date; the key goes in the Authorization header only, never
// in a URL, a log line or an error.
import { z } from 'zod'

// The 30 NBA tricodes. The keeper maps ESPN's own spellings to these (feeds/espn.ts) and
// balldontlie spells all of them the same way, so the mapping is the identity; a code outside
// the list has no balldontlie game.
export const NBA_TRICODES = [
  'ATL',
  'BOS',
  'BKN',
  'CHA',
  'CHI',
  'CLE',
  'DAL',
  'DEN',
  'DET',
  'GSW',
  'HOU',
  'IND',
  'LAC',
  'LAL',
  'MEM',
  'MIA',
  'MIL',
  'MIN',
  'NOP',
  'NYK',
  'OKC',
  'ORL',
  'PHI',
  'PHX',
  'POR',
  'SAC',
  'SAS',
  'TOR',
  'UTA',
  'WAS',
] as const

const KNOWN: ReadonlySet<string> = new Set(NBA_TRICODES)

export const bdlTeam = (code: string): string | null => (KNOWN.has(code) ? code : null)

const BASE = 'https://api.balldontlie.io/v1/games'

/** The evidence's `sources[1].url` on a match. */
export const bdlGameUrl = (id: number) => `${BASE}/${id}`

const score = z.number().int().nullable().optional()
const GameSchema = z.looseObject({
  id: z.number().int(),
  date: z.string(),
  status: z.string(),
  period: z.number().nullable().optional(),
  home_team_score: score,
  visitor_team_score: score,
  home_team: z.looseObject({ abbreviation: z.string() }),
  visitor_team: z.looseObject({ abbreviation: z.string() }),
})
const PageSchema = z.looseObject({ data: z.array(GameSchema) })

export type BdlGame = z.infer<typeof GameSchema>

export class BdlError extends Error {
  override name = 'BdlError'
  constructor(
    /** The HTTP status; 0 when balldontlie did not answer. */
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function fetchGames(
  etDate: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BdlGame[]> {
  const url = new URL(BASE)
  url.searchParams.append('dates[]', etDate)
  url.searchParams.set('per_page', '100')
  let res: Response
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: apiKey, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    // The cause is dropped: a transport error may quote the request.
    throw new BdlError(0, 'balldontlie did not answer')
  }
  if (!res.ok) throw new BdlError(res.status, `balldontlie answered HTTP ${res.status}`)
  const parsed = PageSchema.safeParse(await res.json().catch(() => null))
  if (!parsed.success) throw new BdlError(res.status, 'balldontlie answered an unexpected shape')
  return parsed.data.data
}

export function findGame(
  games: readonly BdlGame[],
  home: string,
  away: string,
): BdlGame | undefined {
  const h = bdlTeam(home)
  const a = bdlTeam(away)
  if (!h || !a) return undefined
  return games.find((g) => g.home_team.abbreviation === h && g.visitor_team.abbreviation === a)
}

/** What the check reads: the state and the two totals (kind 0 compares totals only). */
export interface SecondGame {
  id: number
  state: 'final' | 'postponed' | 'scheduled' | 'live'
  homeScore: number | null
  awayScore: number | null
}

export function secondGame(g: BdlGame): SecondGame {
  const state = /^final/i.test(g.status)
    ? 'final'
    : /postpon|cancel/i.test(g.status)
      ? 'postponed'
      : (g.period ?? 0) === 0
        ? 'scheduled'
        : 'live'
  return {
    id: g.id,
    state,
    homeScore: g.home_team_score ?? null,
    awayScore: g.visitor_team_score ?? null,
  }
}

/** One ET date's games and when they were read (unix seconds). */
export interface DateGames {
  games: BdlGame[]
  fetchedAt: number
}

/**
 * The keeper's client: at most one request a minute per ET date, and a date is left alone for
 * 120 s after a 429 (the free tier allows 5 a minute). `games` returns null when the date is not
 * due yet, and throws a `BdlError` when the request failed.
 */
export class Balldontlie {
  private readonly next = new Map<string, number>()

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly gapSecs = 60,
    private readonly backoffSecs = 120,
  ) {}

  async games(etDate: string, now: number): Promise<DateGames | null> {
    if (now < (this.next.get(etDate) ?? 0)) return null
    this.next.set(etDate, now + this.gapSecs)
    try {
      return { games: await fetchGames(etDate, this.apiKey, this.fetchImpl), fetchedAt: now }
    } catch (err) {
      if (err instanceof BdlError && err.status === 429)
        this.next.set(etDate, now + this.backoffSecs)
      throw err
    }
  }
}
