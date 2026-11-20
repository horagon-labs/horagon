// Builds data/elo.json (spec 7): every regular-season and playoff result of 2025-26 and of
// 2026-27 so far, from ESPN's scoreboard one date at a time (the NBA CDN answers 403), replayed
// through Elo; sigma is the 2025-26 home-margin standard deviation. Raw days are cached under
// data/espn-days/ so a rerun only fetches new dates. One request at a time, with the keeper's
// own User-Agent; any answer other than 200 (a 403 or 429 above all) stops the run.
//   pnpm --filter @horagon/keeper elo:build [--until 2026-11-23]
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { applyResults, type GameResult, marginSigma, type Ratings } from '../src/elo'
import { espnScoreboardUrl, parseEspnScoreboard, USER_AGENT } from '../src/feeds/espn'
import { easternDate } from '../src/feeds/types'
import { gameDateArg, stripArgSeparator } from '../src/ops/args'

const SEASONS = [
  { year: 2026, from: '2025-10-21', to: '2026-06-30' },
  { year: 2027, from: '2026-10-20', to: '2027-06-30' },
]
const DATA = join(import.meta.dirname, '../data')
const CACHE = join(DATA, 'espn-days')

const { values } = parseArgs({
  args: stripArgSeparator(process.argv.slice(2)),
  options: { until: { type: 'string' } },
})
const yesterday = easternDate(new Date(Date.now() - 86_400_000))
const until = values.until ? gameDateArg(values.until, '--until') : yesterday

function* days(from: string, to: string): Generator<string> {
  for (
    let d = new Date(`${from}T12:00:00Z`);
    d.toISOString().slice(0, 10) <= to;
    d = new Date(d.getTime() + 86_400_000)
  ) {
    yield d.toISOString().slice(0, 10)
  }
}

let fetched = 0

async function day(date: string): Promise<unknown> {
  const file = join(CACHE, `${date}.json`)
  const cached = await readFile(file, 'utf8').catch(() => null)
  if (cached) return JSON.parse(cached)
  const res = await fetch(espnScoreboardUrl(date), {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  })
  // No retry, no other headers: a block (403) or a rate limit (429) is reported, not worked around.
  if (!res.ok) throw new Error(`${date}: ESPN answered ${res.status}; stopped (${fetched} fetched)`)
  const body = await res.json()
  fetched++
  // Only cache days that are over, so today's partial board is fetched again next run.
  if (date <= yesterday) await writeFile(file, JSON.stringify(body))
  await new Promise((r) => setTimeout(r, 250))
  return body
}

/** Season type 2 (regular) and 3 (playoffs) finals; preseason, All-Star and play-in skipped. */
function results(body: unknown): Array<GameResult & { id: string }> {
  const types = new Map<string, number>()
  for (const e of (body as { events?: Array<{ id: string; season?: { type?: number } }> }).events ??
    []) {
    types.set(e.id, e.season?.type ?? 0)
  }
  return parseEspnScoreboard(body)
    .games.filter((g) => g.status === 'final' && [2, 3].includes(types.get(g.externalId) ?? 0))
    .map((g) => ({
      id: g.externalId,
      date: g.gameDate,
      home: g.home,
      away: g.away,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
    }))
}

await mkdir(CACHE, { recursive: true })
// By ESPN event id: a game listed on two date boards counts once.
const byId = new Map<string, GameResult>()
for (const s of SEASONS) {
  const last = [s.to, until].sort()[0] as string
  for (const date of days(s.from, last)) {
    for (const { id, ...r } of results(await day(date))) byId.set(id, r)
  }
}
const all = [...byId.values()]
const lastSeason = all.filter((r) => r.date >= '2025-10-21' && r.date <= '2026-06-30')
const start: Ratings = { asOf: '2025-08-01', sigma: marginSigma(lastSeason), teams: {} }
const ratings = applyResults(start, all)
await writeFile(join(DATA, 'elo.json'), `${JSON.stringify(ratings, null, 2)}\n`)
console.log(
  `elo.json: ${all.length} results to ${ratings.asOf}, sigma ${ratings.sigma}, ${Object.keys(ratings.teams).length} teams`,
)
