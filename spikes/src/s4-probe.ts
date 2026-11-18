// Spike S4 (probe): from this machine, can we read the NBA CDN (scoreboard, boxscore, schedule)
// and ESPN, and do Kalshi or Polymarket publish NBA game prices? Run it from a datacenter too
// (`.github/workflows/feed-probe.yml`), since home IPs and cloud IPs are treated differently.
import {
  ESPN_SCOREBOARD_URL,
  type EspnScoreboard,
  espnSummaryUrl,
  type Fetched,
  getJson,
  KALSHI_NBA_GAMES_URL,
  NBA_SCHEDULE_URL,
  NBA_SCOREBOARD_URL,
  type NbaScoreboard,
  nbaBoxscoreUrl,
  POLYMARKET_GAME_SLUG,
  POLYMARKET_NBA_EVENTS_URL,
} from './lib/feeds'
import { runSpike, SpikeRun } from './lib/results'

const where = process.env.HORAGON_PROBE_SITE ?? 'local'
const run = new SpikeRun(`s4-probe-${where}`, 'n/a')

const summary = (f: Fetched) => ({
  status: f.status,
  ms: f.ms,
  bytes: f.bytes,
  headers: f.headers,
  topLevelKeys: f.json && typeof f.json === 'object' ? Object.keys(f.json).slice(0, 12) : [],
})

async function probe(name: string, url: string): Promise<Fetched | undefined> {
  try {
    const f = await getJson(url)
    run.record(name, summary(f))
    run.check(
      `${name} answers 200 with JSON`,
      f.status === 200 && f.json !== null,
      `HTTP ${f.status}, ${f.ms} ms`,
    )
    return f
  } catch (e) {
    run.check(`${name} answers 200 with JSON`, false, String(e))
    return undefined
  }
}

await runSpike(run, async () => {
  const scoreboard = await probe('nba-scoreboard', NBA_SCOREBOARD_URL)
  const games = (scoreboard?.json as NbaScoreboard | undefined)?.scoreboard.games ?? []
  run.record(
    'nba-games',
    games.map(
      (g) => `${g.gameId} ${g.awayTeam.teamTricode}@${g.homeTeam.teamTricode} ${g.gameStatusText}`,
    ),
  )
  // Boxscores exist once a game has started; pick a live or final one when there is one.
  const started = games.find((g) => g.gameStatus >= 2) ?? games[0]
  if (started) await probe('nba-boxscore', nbaBoxscoreUrl(started.gameId))
  await probe('nba-schedule', NBA_SCHEDULE_URL)

  const espn = await probe('espn-scoreboard', ESPN_SCOREBOARD_URL)
  const events = (espn?.json as EspnScoreboard | undefined)?.events ?? []
  run.record(
    'espn-events',
    events.map((e) => {
      const c = e.competitions[0]
      const team = (side: 'home' | 'away') =>
        c?.competitors.find((x) => x.homeAway === side)?.team.abbreviation
      return `${e.id} ${team('away')}@${team('home')} ${c?.status.type.state}`
    }),
  )
  if (events[0]) await probe('espn-summary', espnSummaryUrl(events[0].id))

  // Reference odds (component C). Availability only; ToS is read by hand (docs/spikes.md).
  const kalshi = await probe('kalshi-nba-games', KALSHI_NBA_GAMES_URL)
  const kalshiMarkets =
    (kalshi?.json as { markets?: Array<Record<string, unknown>> } | undefined)?.markets ?? []
  run.check(
    'Kalshi lists single NBA games',
    kalshiMarkets.length > 0,
    `${kalshiMarkets.length} markets`,
  )
  run.record(
    'kalshi-sample',
    kalshiMarkets
      .slice(0, 3)
      .map((m) => ({ ticker: m.ticker, title: m.title, yes_bid: m.yes_bid, yes_ask: m.yes_ask })),
  )
  const poly = await probe('polymarket-nba-events', POLYMARKET_NBA_EVENTS_URL)
  const polyEvents = Array.isArray(poly?.json) ? (poly.json as Array<Record<string, unknown>>) : []
  // The nba tag also holds futures; single games have slugs like nba-bos-gsw-2026-11-22.
  const polyGames = polyEvents.filter((e) => POLYMARKET_GAME_SLUG.test(String(e.slug)))
  run.check('Polymarket lists single NBA games', polyGames.length > 0, `${polyGames.length} games`)
  run.record(
    'polymarket-sample',
    polyGames.slice(0, 3).map((e) => ({ slug: e.slug, title: e.title })),
  )
})
