// Spike S4 (recorder): records one NBA night as raw NDJSON in spikes/recordings/ (git-ignored).
// Scoreboards: NBA CDN every 10 s, ESPN every 15 s. Per live game every 30 s: NBA boxscore
// and ESPN summary; once more when a game turns final, so the recording holds a final box
// score. A body identical to the previous one for the same URL is stored as {same: true}.
// Either feed may be down (the NBA CDN answers 403 to some networks): after 3 non-2xx answers
// in a row the NBA scoreboard is polled every 5 minutes until it answers 2xx again, and the
// request itself never changes. The recorder is meant to run unattended all night, so no single
// error may end it: every task runs inside a try/catch, bad feed bodies are skipped, and a
// failed disk append is logged and ignored. A heartbeat line is printed every 15 minutes
// (HORAGON_HEARTBEAT_MS overrides the period, for testing). Stops when every game has been
// final for 10 minutes, or after --hours.
//   pnpm --filter @horagon/spikes s4:record [--hours 8]
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { sleep } from './lib/env'
import {
  ESPN_SCOREBOARD_URL,
  type EspnEvent,
  espnSummaryUrl,
  getJson,
  NBA_SCOREBOARD_URL,
  type NbaGame,
  nbaBoxscoreUrl,
} from './lib/feeds'

export const RECORDINGS_DIR = join(import.meta.dirname, '../recordings')

const NBA_POLL_MS = 10_000
const NBA_BACKOFF_POLL_MS = 300_000
const NBA_BACKOFF_AFTER = 3
const ESPN_POLL_MS = 15_000
const DETAIL_POLL_MS = 30_000
const FINAL_GRACE_MS = 600_000
const FINAL_FETCH_ATTEMPTS = 3
const heartbeatOverride = Number(process.env.HORAGON_HEARTBEAT_MS)
const HEARTBEAT_MS = heartbeatOverride > 0 ? heartbeatOverride : 900_000

const hoursArg = process.argv.indexOf('--hours')
const hours = hoursArg >= 0 ? Number(process.argv[hoursArg + 1]) : 8
if (!(hours > 0)) throw new Error('--hours must be a positive number')
const stopAt = Date.now() + hours * 3_600_000
const file = join(RECORDINGS_DIR, `${new Date().toISOString().slice(0, 10)}.ndjson`)
mkdirSync(RECORDINGS_DIR, { recursive: true })

type Feed = 'nba' | 'espn'
interface Snapshot {
  live: Set<string>
  final: Set<string>
  total: number
}
const emptySnapshot = (): Snapshot => ({ live: new Set(), final: new Set(), total: 0 })

const lastHash = new Map<string, string>()
const snap: Record<Feed, Snapshot> = { nba: emptySnapshot(), espn: emptySnapshot() }
// Games that turned final and still need their last box score: id -> attempts so far.
const pendingFinal: Record<Feed, Map<string, number>> = { nba: new Map(), espn: new Map() }
const finalQueued: Record<Feed, Set<string>> = { nba: new Set(), espn: new Set() }
let nbaFails = 0
let linesWritten = 0
let sawLive = false
let allFinalSince: number | undefined

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Appends one record. Never throws: a full disk must not end the night. */
function append(record: object): void {
  try {
    appendFileSync(file, `${JSON.stringify(record)}\n`)
    linesWritten++
  } catch (e) {
    console.error(`${new Date().toISOString()} append failed: ${String(e)}`)
  }
}

function report(where: string, e: unknown): void {
  try {
    console.error(
      `${new Date().toISOString()} ${where}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    )
    append({ t: new Date().toISOString(), src: 'recorder', error: `${where}: ${String(e)}` })
  } catch {
    // Reporting must never throw.
  }
}

interface Captured {
  /** HTTP status; undefined when the request itself failed. */
  status?: number
  /** The parsed body, only for a 200. */
  body?: unknown
}

async function capture(src: string, url: string): Promise<Captured> {
  const t = new Date().toISOString()
  try {
    const f = await getJson(url)
    const hash = createHash('sha1').update(JSON.stringify(f.json)).digest('hex')
    const same = lastHash.get(url) === hash
    lastHash.set(url, hash)
    append({
      t,
      src,
      url,
      status: f.status,
      ms: f.ms,
      etag: f.headers.etag,
      ...(same ? { same: true } : { body: f.json }),
    })
    return { status: f.status, body: f.status === 200 ? f.json : undefined }
  } catch (e) {
    append({ t, src, url, error: String(e) })
    return {}
  }
}

// Feed bodies are untrusted: read them defensively and skip what does not fit.
function nbaGames(body: unknown): NbaGame[] {
  const games = isRecord(body) && isRecord(body.scoreboard) ? body.scoreboard.games : undefined
  return Array.isArray(games)
    ? games.filter((g): g is NbaGame => isRecord(g) && typeof g.gameId === 'string')
    : []
}

function espnEvents(body: unknown): EspnEvent[] {
  const events = isRecord(body) ? body.events : undefined
  return Array.isArray(events)
    ? events.filter((e): e is EspnEvent => isRecord(e) && typeof e.id === 'string')
    : []
}

const espnType = (e: EspnEvent) => e.competitions?.[0]?.status?.type

function queueFinal(feed: Feed, ids: Iterable<string>): void {
  for (const id of ids) {
    if (finalQueued[feed].has(id)) continue
    finalQueued[feed].add(id)
    pendingFinal[feed].set(id, 0)
  }
}

function updateDone(): void {
  const liveCount = snap.nba.live.size + snap.espn.live.size
  if (liveCount > 0) sawLive = true
  const allFinal = (Object.values(snap) as Snapshot[]).some(
    (s) => s.total > 0 && s.final.size === s.total,
  )
  // A feed that still shows a live game vetoes "all final", even if the other feed is stale.
  allFinalSince = allFinal && liveCount === 0 ? (allFinalSince ?? Date.now()) : undefined
}

const done = () =>
  sawLive && allFinalSince !== undefined && Date.now() - allFinalSince > FINAL_GRACE_MS

/** NBA CDN health: only non-2xx answers count; a failed request neither counts nor resets. */
function trackNbaHealth(status: number | undefined): void {
  if (status === undefined) return
  const ok = status >= 200 && status < 300
  if (ok) {
    if (nbaFails >= NBA_BACKOFF_AFTER)
      console.log(
        `${new Date().toISOString()} NBA CDN answers ${status} again: back to polling every ${NBA_POLL_MS / 1000} s`,
      )
    nbaFails = 0
    return
  }
  nbaFails++
  if (nbaFails === NBA_BACKOFF_AFTER) {
    console.log(
      `${new Date().toISOString()} NBA CDN answered HTTP ${status} ${NBA_BACKOFF_AFTER} times in a row: polling it every ${NBA_BACKOFF_POLL_MS / 60_000} min until it answers 2xx`,
    )
  }
}

async function pollNba(): Promise<void> {
  const { status, body } = await capture('nba-scoreboard', NBA_SCOREBOARD_URL)
  trackNbaHealth(status)
  const games = nbaGames(body)
  snap.nba = {
    live: new Set(games.filter((g) => g.gameStatus === 2).map((g) => g.gameId)),
    final: new Set(games.filter((g) => g.gameStatus === 3).map((g) => g.gameId)),
    total: games.length,
  }
  queueFinal('nba', snap.nba.final)
  updateDone()
}

async function pollEspn(): Promise<void> {
  const { body } = await capture('espn-scoreboard', ESPN_SCOREBOARD_URL)
  const events = espnEvents(body)
  const inState = (state: string) =>
    events.filter((e) => espnType(e)?.state === state).map((e) => e.id)
  snap.espn = {
    live: new Set(inState('in')),
    // For the stop rule a postponed game counts as over; only completed games have a box score.
    final: new Set(inState('post')),
    total: events.length,
  }
  queueFinal(
    'espn',
    events.filter((e) => espnType(e)?.completed === true).map((e) => e.id),
  )
  updateDone()
}

async function drainFinal(feed: Feed, src: string, urlOf: (id: string) => string): Promise<void> {
  for (const [id, attempts] of [...pendingFinal[feed]]) {
    const { status } = await capture(src, urlOf(id))
    if (status === 200 || attempts + 1 >= FINAL_FETCH_ATTEMPTS) pendingFinal[feed].delete(id)
    else pendingFinal[feed].set(id, attempts + 1)
  }
}

async function pollDetails(): Promise<void> {
  for (const id of snap.nba.live) await capture('nba-boxscore', nbaBoxscoreUrl(id))
  for (const id of snap.espn.live) await capture('espn-summary', espnSummaryUrl(id))
  await drainFinal('nba', 'nba-boxscore', nbaBoxscoreUrl)
  await drainFinal('espn', 'espn-summary', espnSummaryUrl)
}

/** Sleeps until `wake`, but wakes early when the run is over. */
async function napUntil(wake: number): Promise<void> {
  while (Date.now() < wake && Date.now() < stopAt && !done()) {
    await sleep(Math.min(1000, wake - Date.now()))
  }
}

async function every(name: string, period: () => number, task: () => Promise<void>): Promise<void> {
  while (Date.now() < stopAt && !done()) {
    const started = Date.now()
    try {
      await task()
    } catch (e) {
      report(name, e)
    }
    await napUntil(started + period())
  }
}

function heartbeat(): void {
  try {
    const most = (pick: (s: Snapshot) => number) => Math.max(pick(snap.nba), pick(snap.espn))
    console.log(
      `${new Date().toISOString()} heartbeat: ${linesWritten} lines written, ${most((s) => s.live.size)} live, ${most((s) => s.final.size)} final (nba ${nbaFails >= NBA_BACKOFF_AFTER ? 'backing off' : 'polling'})`,
    )
  } catch {
    // A broken stdout must not end the recording.
  }
}

process.on('unhandledRejection', (e) => report('unhandledRejection', e))
process.on('uncaughtException', (e) => report('uncaughtException', e))

console.log(`recording to ${file} until ${new Date(stopAt).toISOString()}`)
const beat = setInterval(heartbeat, HEARTBEAT_MS)
await Promise.all([
  every(
    'nba-scoreboard',
    () => (nbaFails >= NBA_BACKOFF_AFTER ? NBA_BACKOFF_POLL_MS : NBA_POLL_MS),
    pollNba,
  ),
  every('espn-scoreboard', () => ESPN_POLL_MS, pollEspn),
  every('details', () => DETAIL_POLL_MS, pollDetails),
])
clearInterval(beat)
console.log(`done: ${file} (${linesWritten} lines)`)
