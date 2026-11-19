// Spike S4 (probe): from this machine, can we read the NBA CDN (scoreboard, boxscore, schedule)
// and ESPN? Run it from a datacenter too (`.github/workflows/feed-probe.yml`), since home IPs
// and cloud IPs are treated differently. Reference odds (component C) are out of the MVP and
// Kalshi's terms bar scripted access, so this probe makes no Kalshi or Polymarket call.
import {
  ESPN_SCOREBOARD_URL,
  type EspnScoreboard,
  espnSummaryUrl,
  type Fetched,
  getJson,
  NBA_SCHEDULE_URL,
  NBA_SCOREBOARD_URL,
  type NbaScoreboard,
  nbaBoxscoreUrl,
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
})
