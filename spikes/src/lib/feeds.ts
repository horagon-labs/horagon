// Public NBA feeds (no ToS or SLA: display and cross-checking only) and reference-odds APIs.
export const USER_AGENT = 'horagon-spike/0.0 (+https://github.com/horagon-labs/horagon)'

export const NBA_SCOREBOARD_URL =
  'https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json'
export const NBA_SCHEDULE_URL = 'https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json'
export const nbaBoxscoreUrl = (gameId: string) =>
  `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_${gameId}.json`

export const ESPN_SCOREBOARD_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'
export const espnSummaryUrl = (eventId: string) =>
  `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${eventId}`

export const KALSHI_NBA_GAMES_URL =
  'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXNBAGAME&status=open&limit=20'
// Pages above limit=50 are served gzip-only; fetch() sends Accept-Encoding: gzip by default.
export const POLYMARKET_NBA_EVENTS_URL =
  'https://gamma-api.polymarket.com/events?tag_slug=nba&closed=false&limit=100'
export const POLYMARKET_GAME_SLUG = /^nba-[a-z]{2,4}-[a-z]{2,4}-\d{4}-\d{2}-\d{2}$/

/** ESPN team abbreviations that differ from NBA tricodes. */
export const ESPN_TO_NBA_TRICODE: Readonly<Record<string, string>> = {
  GS: 'GSW',
  NY: 'NYK',
  NO: 'NOP',
  SA: 'SAS',
  UTAH: 'UTA',
  WSH: 'WAS',
}

export interface Fetched {
  url: string
  status: number
  ms: number
  bytes: number
  headers: Record<string, string>
  json: unknown
}

const KEPT_HEADERS = [
  'content-type',
  'cache-control',
  'etag',
  'last-modified',
  'age',
  'retry-after',
]

export async function getJson(url: string, timeoutMs = 15_000): Promise<Fetched> {
  const started = performance.now()
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  const headers: Record<string, string> = {}
  for (const h of KEPT_HEADERS) {
    const v = res.headers.get(h)
    if (v !== null) headers[h] = v
  }
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    // Not JSON (an HTML error page, say): keep json = null.
  }
  return {
    url,
    status: res.status,
    ms: Math.round(performance.now() - started),
    bytes: text.length,
    headers,
    json,
  }
}

// The slices of each feed that Horagon reads. Everything else is ignored.
export interface NbaTeam {
  teamTricode: string
  score: number
}
export interface NbaGame {
  gameId: string
  gameStatus: number // 1 scheduled, 2 live, 3 final
  gameStatusText: string
  period: number
  gameClock: string // ISO 8601 duration, e.g. "PT05M12.00S"
  gameTimeUTC: string
  homeTeam: NbaTeam
  awayTeam: NbaTeam
}
export interface NbaScoreboard {
  scoreboard: { gameDate: string; games: NbaGame[] }
}

export interface EspnCompetitor {
  homeAway: 'home' | 'away'
  score?: string
  team: { abbreviation: string }
}
export interface EspnEvent {
  id: string
  date: string
  competitions: Array<{
    status: {
      displayClock: string
      period: number
      type: { state: 'pre' | 'in' | 'post'; completed: boolean }
    }
    competitors: EspnCompetitor[]
  }>
}
export interface EspnScoreboard {
  events: EspnEvent[]
}

export const nbaTricode = (espnAbbreviation: string) =>
  ESPN_TO_NBA_TRICODE[espnAbbreviation] ?? espnAbbreviation

export type FrameStatus = 'pre' | 'live' | 'final' | 'postponed'

/** ESPN marks a postponed game `post` without `completed`: it must never read as final. */
export const espnStatus = (type: {
  state: 'pre' | 'in' | 'post'
  completed: boolean
}): FrameStatus =>
  type.state === 'in'
    ? 'live'
    : type.state === 'pre'
      ? 'pre'
      : type.completed
        ? 'final'
        : 'postponed'
