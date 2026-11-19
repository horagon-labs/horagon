// Fetch NBA game timelines for the end_ts analysis: ESPN's public scoreboard for each date, then
// the summary of each completed regular-season game, keeping only the plays' wallclock, period,
// clock and score. Read-only, one request per second, with Horagon's own User-Agent.
//
//   pnpm --filter @horagon/spikes end-ts:fetch 2026-10-20 2026-11-18
//
// Writes spikes/data/espn-games-<from>-<to>.json.gz, the input of `end-ts`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { clockSecs, DATA_DIR, type GameTimeline, type Play } from './lib/end-ts'
import { sleep } from './lib/env'
import { ESPN_SCOREBOARD_URL, espnSummaryUrl, getJson } from './lib/feeds'

interface ScoreboardEvent {
  id: string
  date: string
  shortName: string
  season?: { type?: number }
  status?: { period?: number; type?: { completed?: boolean } }
}
interface SummaryPlay {
  wallclock?: string
  period?: { number?: number }
  clock?: { displayValue?: string }
  homeScore?: number
  awayScore?: number
  type?: { text?: string }
}

const REGULAR_SEASON = 2

async function json<T>(url: string): Promise<T | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const f = await getJson(url).catch((e: unknown) => {
      console.error(`attempt ${attempt}: ${String(e)} ${url}`)
      return null
    })
    await sleep(1_000)
    if (f?.status === 200 && f.json !== null) return f.json as T
    if (f) console.error(`attempt ${attempt}: HTTP ${f.status} ${url}`)
    await sleep(2_000)
  }
  return null
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll('-', '')

const [from, to] = process.argv.slice(2)
if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
  console.error('usage: end-ts-fetch <from YYYY-MM-DD> <to YYYY-MM-DD> (ESPN game dates)')
  process.exit(2)
}
const games: GameTimeline[] = []
const failed: string[] = []
for (let d = new Date(`${from}T12:00:00Z`); d <= new Date(`${to}T12:00:00Z`); ) {
  const date = ymd(d)
  const board = await json<{ events?: ScoreboardEvent[] }>(`${ESPN_SCOREBOARD_URL}?dates=${date}`)
  if (!board) failed.push(`scoreboard ${date}`)
  for (const e of board?.events ?? []) {
    if (e.season?.type !== REGULAR_SEASON || e.status?.type?.completed !== true) continue
    const summary = await json<{ plays?: SummaryPlay[] }>(espnSummaryUrl(e.id))
    if (!summary) {
      failed.push(`summary ${e.id}`)
      continue
    }
    const plays: Play[] = (summary.plays ?? [])
      .filter((p) => p.wallclock)
      .map((p) => [
        Date.parse(p.wallclock as string),
        p.period?.number ?? 0,
        clockSecs(p.clock?.displayValue),
        p.homeScore ?? 0,
        p.awayScore ?? 0,
        /End Game/i.test(p.type?.text ?? '') ? 1 : 0,
      ])
    if (plays.length === 0) {
      failed.push(`no wallclock ${e.id}`)
      continue
    }
    games.push({
      id: e.id,
      date,
      scheduled: e.date,
      name: e.shortName,
      periods: e.status?.period ?? 4,
      plays,
    })
    console.log(`${date} ${e.shortName}: ${plays.length} plays`)
  }
  d = new Date(d.getTime() + 86_400_000)
}
mkdirSync(DATA_DIR, { recursive: true })
const file = join(DATA_DIR, `espn-games-${from}-${to}.json.gz`)
const body = {
  source: 'ESPN scoreboard + summary',
  fetchedAt: new Date().toISOString(),
  from,
  to,
  games,
}
writeFileSync(file, gzipSync(`${JSON.stringify(body)}\n`))
console.log(
  `${games.length} games, ${failed.length} failed${failed.length ? `: ${failed.join(', ')}` : ''}`,
)
console.log(file)
if (failed.length) process.exit(1)
