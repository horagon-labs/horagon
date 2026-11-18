// Spike S4 (recorder): records one NBA night as raw NDJSON in spikes/recordings/ (git-ignored).
// Scoreboards: NBA CDN every 10 s, ESPN every 15 s. Per live game every 30 s: NBA boxscore
// and ESPN summary. A body identical to the previous one for the same URL is stored as
// {same: true}. Either feed may be down (the NBA CDN answers 403 to some networks); the other
// keeps recording. Stops when every game has been final for 10 minutes, or after --hours.
//   pnpm --filter @horagon/spikes s4:record [--hours 8]
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { sleep } from './lib/env'
import {
  ESPN_SCOREBOARD_URL,
  type EspnScoreboard,
  espnSummaryUrl,
  getJson,
  NBA_SCOREBOARD_URL,
  type NbaScoreboard,
  nbaBoxscoreUrl,
} from './lib/feeds'

export const RECORDINGS_DIR = join(import.meta.dirname, '../recordings')

const hoursArg = process.argv.indexOf('--hours')
const hours = hoursArg >= 0 ? Number(process.argv[hoursArg + 1]) : 8
const stopAt = Date.now() + hours * 3_600_000
const file = join(RECORDINGS_DIR, `${new Date().toISOString().slice(0, 10)}.ndjson`)
mkdirSync(RECORDINGS_DIR, { recursive: true })

const lastHash = new Map<string, string>()
const live = { nba: new Set<string>(), espn: new Set<string>() }
const allFinal = { nba: false, espn: false }
let sawLive = false
let allFinalSince: number | undefined

async function capture(src: string, url: string): Promise<unknown> {
  const t = new Date().toISOString()
  try {
    const f = await getJson(url)
    const hash = createHash('sha1').update(JSON.stringify(f.json)).digest('hex')
    const same = lastHash.get(url) === hash
    lastHash.set(url, hash)
    const line = {
      t,
      src,
      url,
      status: f.status,
      ms: f.ms,
      etag: f.headers.etag,
      ...(same ? { same: true } : { body: f.json }),
    }
    appendFileSync(file, `${JSON.stringify(line)}\n`)
    return f.status === 200 ? f.json : undefined
  } catch (e) {
    appendFileSync(file, `${JSON.stringify({ t, src, url, error: String(e) })}\n`)
    return undefined
  }
}

function updateDone(): void {
  if (live.nba.size + live.espn.size > 0) sawLive = true
  const final = allFinal.nba || allFinal.espn
  allFinalSince = final ? (allFinalSince ?? Date.now()) : undefined
}

const done = () => sawLive && allFinalSince !== undefined && Date.now() - allFinalSince > 600_000

async function every(ms: number, task: () => Promise<void>): Promise<void> {
  while (Date.now() < stopAt && !done()) {
    const started = Date.now()
    await task()
    await sleep(Math.max(0, ms - (Date.now() - started)))
  }
}

console.log(`recording to ${file} until ${new Date(stopAt).toISOString()}`)
await Promise.all([
  every(10_000, async () => {
    const body = (await capture('nba-scoreboard', NBA_SCOREBOARD_URL)) as NbaScoreboard | undefined
    const games = body?.scoreboard?.games ?? []
    live.nba = new Set(games.filter((g) => g.gameStatus === 2).map((g) => g.gameId))
    allFinal.nba = games.length > 0 && games.every((g) => g.gameStatus === 3)
    updateDone()
  }),
  every(15_000, async () => {
    const body = (await capture('espn-scoreboard', ESPN_SCOREBOARD_URL)) as
      | EspnScoreboard
      | undefined
    const events = body?.events ?? []
    const state = (e: (typeof events)[number]) => e.competitions[0]?.status.type.state
    live.espn = new Set(events.filter((e) => state(e) === 'in').map((e) => e.id))
    allFinal.espn = events.length > 0 && events.every((e) => state(e) === 'post')
    updateDone()
  }),
  every(30_000, async () => {
    for (const id of live.nba) await capture('nba-boxscore', nbaBoxscoreUrl(id))
    for (const id of live.espn) await capture('espn-summary', espnSummaryUrl(id))
  }),
])
console.log(`done: ${file}`)
