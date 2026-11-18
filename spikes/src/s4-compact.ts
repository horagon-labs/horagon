// Spike S4 (compact): turns a raw recording into one replay fixture per game, with a frame
// whenever a feed's status, period, clock or score changes. Games are matched across feeds by
// tricodes (AWAY@HOME); either feed alone is enough. `--raw <AWAY@HOME>` also keeps that game's
// raw lines, gzipped, for parser tests: every scoreboard line plus that game's boxscore and
// summary lines. A full night is several hundred MB, so the recording is streamed line by line
// (never held in memory), only the scoreboard lines are parsed, and a line that is truncated or
// malformed is counted and skipped.
//   pnpm --filter @horagon/spikes s4:compact recordings/2026-11-20.ndjson [--raw NYK@TOR]
import { createReadStream, createWriteStream, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import {
  type EspnScoreboard,
  espnStatus,
  type FrameStatus,
  type NbaScoreboard,
  nbaTricode,
} from './lib/feeds'

export const REPLAY_DIR = join(import.meta.dirname, '../../tests/fixtures/replay')

export interface ReplayFrame {
  t: string
  source: 'nba' | 'espn'
  status: FrameStatus
  period: number
  clock: string
  homeScore: number
  awayScore: number
}

/** Fixture format read by the keeper's replay mode (Tier 1). */
export interface ReplayGame {
  schema: 'horagon.replay.v0'
  /** Game date in US Eastern time, as the NBA schedules it. */
  gameDate: string
  home: string
  away: string
  tipoffUtc: string
  nbaGameId?: string
  espnEventId?: string
  frames: ReplayFrame[]
}

interface RawLine {
  t: string
  src: string
  url: string
  body?: unknown
}

const NBA_STATUS: Record<number, FrameStatus> = { 1: 'pre', 2: 'live', 3: 'final' }
const easternDate = (iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso))

const [input, ...rest] = process.argv.slice(2)
if (!input) throw new Error('usage: s4:compact <recording.ndjson> [--raw AWAY@HOME ...]')
const inputPath = resolve(input)
const keepRaw = new Set(rest.filter((_, i) => rest[i - 1] === '--raw'))

/** Non-empty lines of a file, streamed. */
async function* linesOf(path: string): AsyncGenerator<string> {
  const reader = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  })
  for await (const line of reader) if (line !== '') yield line
}

const HEAD = /^\{"t":"[^"]*","src":"([^"]*)"/

/**
 * The `src` of a recorder line, read from its first characters without parsing the body.
 * undefined means the line is not a whole recorder line (truncated by a crash, or garbage).
 */
function srcOf(line: string): string | undefined {
  if (!line.endsWith('}')) return undefined
  return HEAD.exec(line.slice(0, 120))?.[1]
}

const isScoreboard = (src: string | undefined) =>
  src === 'nba-scoreboard' || src === 'espn-scoreboard'

const games = new Map<string, ReplayGame>()
const lastFrame = new Map<string, string>()

function game(away: string, home: string, tipoffUtc: string): ReplayGame {
  const key = `${away}@${home}`
  let g = games.get(key)
  if (!g) {
    g = {
      schema: 'horagon.replay.v0',
      gameDate: easternDate(tipoffUtc),
      home,
      away,
      tipoffUtc,
      frames: [],
    }
    games.set(key, g)
  }
  return g
}

function push(g: ReplayGame, frame: ReplayFrame): void {
  const key = `${g.away}@${g.home}:${frame.source}`
  const { t: _t, ...comparable } = frame
  const sig = JSON.stringify(comparable)
  if (lastFrame.get(key) === sig) return
  lastFrame.set(key, sig)
  g.frames.push(frame)
}

function ingest(line: RawLine): void {
  if (line.body == null) return
  if (line.src === 'nba-scoreboard') {
    const list = (line.body as Partial<NbaScoreboard>).scoreboard?.games
    for (const n of Array.isArray(list) ? list : []) {
      const g = game(n.awayTeam.teamTricode, n.homeTeam.teamTricode, n.gameTimeUTC)
      g.nbaGameId = n.gameId
      push(g, {
        t: line.t,
        source: 'nba',
        status: NBA_STATUS[n.gameStatus] ?? 'pre',
        period: n.period,
        clock: n.gameClock,
        homeScore: n.homeTeam.score,
        awayScore: n.awayTeam.score,
      })
    }
  } else if (line.src === 'espn-scoreboard') {
    const list = (line.body as Partial<EspnScoreboard>).events
    for (const e of Array.isArray(list) ? list : []) {
      const c = e.competitions[0]
      const home = c?.competitors.find((x) => x.homeAway === 'home')
      const away = c?.competitors.find((x) => x.homeAway === 'away')
      if (!c || !home || !away) continue
      const g = game(nbaTricode(away.team.abbreviation), nbaTricode(home.team.abbreviation), e.date)
      g.espnEventId = e.id
      push(g, {
        t: line.t,
        source: 'espn',
        status: espnStatus(c.status.type),
        period: c.status.period,
        clock: c.status.displayClock,
        homeScore: Number(home.score ?? 0),
        awayScore: Number(away.score ?? 0),
      })
    }
  }
}

// Pass 1: frames. Only scoreboard lines are parsed; everything else is skipped by prefix.
let totalLines = 0
let scoreboardLines = 0
let skipped = 0
// Numbers of scoreboard lines that are not JSON, so the raw pass can leave them out.
const unparseable = new Set<number>()
for await (const text of linesOf(inputPath)) {
  totalLines++
  const src = srcOf(text)
  if (src === undefined) {
    skipped++
    continue
  }
  if (!isScoreboard(src)) continue
  let parsed: RawLine
  try {
    parsed = JSON.parse(text) as RawLine
  } catch {
    skipped++
    unparseable.add(totalLines)
    continue
  }
  try {
    ingest(parsed)
    scoreboardLines++
  } catch {
    skipped++
  }
}

mkdirSync(join(REPLAY_DIR, 'raw'), { recursive: true })
for (const g of games.values()) {
  const name = `${g.gameDate}-${g.away}-at-${g.home}`
  writeFileSync(join(REPLAY_DIR, `${name}.json`), `${JSON.stringify(g, null, 1)}\n`)
  console.log(`${name}.json: ${g.frames.length} frames`)
}

// Pass 2 (only with --raw): stream the selected lines straight into a gzip file.
async function* rawLinesOf(g: ReplayGame): AsyncGenerator<string> {
  let lineNo = 0
  for await (const text of linesOf(inputPath)) {
    lineNo++
    const src = srcOf(text)
    if (isScoreboard(src)) {
      if (!unparseable.has(lineNo)) yield `${text}\n`
      continue
    }
    const id =
      src === 'nba-boxscore' ? g.nbaGameId : src === 'espn-summary' ? g.espnEventId : undefined
    if (id === undefined) continue
    const url = /"url":"([^"]*)"/.exec(text.slice(0, 400))?.[1] ?? ''
    if (
      src === 'nba-boxscore' ? url.endsWith(`boxscore_${id}.json`) : url.endsWith(`event=${id}`)
    ) {
      yield `${text}\n`
    }
  }
}

for (const key of keepRaw) {
  const g = games.get(key)
  if (!g) {
    console.error(
      `warning: --raw ${key} matches no game in the recording (games found: ${[...games.keys()].join(', ') || 'none'})`,
    )
    continue
  }
  const name = `${g.gameDate}-${g.away}-at-${g.home}`
  const out = join(REPLAY_DIR, 'raw', `${name}.ndjson.gz`)
  await pipeline(rawLinesOf(g), createGzip(), createWriteStream(out))
  console.log(`raw/${name}.ndjson.gz: ${statSync(out).size} bytes`)
}

console.log(
  `read ${totalLines} lines, ${scoreboardLines} scoreboard lines used, ${skipped} skipped (truncated or malformed)`,
)
