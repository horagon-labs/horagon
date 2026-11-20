// Spike S4 (compact): turns a raw recording into one replay fixture per game, with a frame
// whenever a feed's status, period, clock or score changes. Games are matched across feeds by
// tricodes (AWAY@HOME); either feed alone is enough. `--raw <AWAY@HOME>` also keeps a gzipped
// sample of that game's raw lines for parser tests (rule: lib/raw-sample.ts). Scoreboard lines:
// per feed, the first and last frame's line and, at every status or period change, the line
// before and the line of the change. Detail lines (the game's boxscore or summary): for each kept
// scoreboard line, the next fetch that has a body, plus the game's last one. Every kept line is
// trimmed: its body loses the editorial, media and odds keys of TRIMMED_KEYS (news, videos,
// plays, odds, ...) at any depth, and a `trimmed` field lists what went, so that third-party
// content does not enter the repo. A full night is several hundred MB, so the recording is
// streamed line by line (never held in memory). Pass 1 parses only the scoreboard lines (detail
// lines are read by their first characters); pass 2 also parses the lines it picks, in order to
// trim them. A line that is truncated or malformed is counted and skipped.
//   pnpm --filter @horagon/spikes s4:compact recordings/2026-11-20.ndjson [--raw NYK@TOR]
import { createReadStream, createWriteStream, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
// The fixture format lives in `@horagon/sdk/replay`, shared with the keeper's replay mode.
import type { ReplayFrame, ReplayGameInput as ReplayGame } from '@horagon/sdk/replay'
import {
  type EspnScoreboard,
  espnStatus,
  type FrameStatus,
  type NbaScoreboard,
  nbaTricode,
} from './lib/feeds'
import {
  type DetailLine,
  pickDetailLines,
  sampleScoreboardTimes,
  trimRecord,
} from './lib/raw-sample'

export const REPLAY_DIR = join(import.meta.dirname, '../../tests/fixtures/replay')

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

/** The `t` of a recorder line (the frame time of a scoreboard line). */
const timeOf = (line: string) => /^\{"t":"([^"]*)"/.exec(line.slice(0, 60))?.[1]

const isScoreboard = (src: string | undefined) =>
  src === 'nba-scoreboard' || src === 'espn-scoreboard'

// Reading a detail line (a game's boxscore or summary fetch) without parsing it: the game id
// comes from the url; it carries a body unless it is a `{same: true}` record, an error or null.
const DETAIL_ID: Record<string, RegExp> = {
  'nba-boxscore': /boxscore_([^/]*)\.json$/,
  'espn-summary': /event=([^&]*)$/,
}
const WITH_BODY =
  /^\{"t":"[^"]*","src":"[^"]*","url":"[^"]*","status":\d+,"ms":\d+(?:,"etag":"(?:[^"\\]|\\.)*")?,"body":[^n]/

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
// Where each game's detail fetches sit in the file ("src:id" -> lines in recording order), so
// the raw pass can pick among them without a third read.
const detailLines = new Map<string, Array<DetailLine & { lineNo: number }>>()
for await (const text of linesOf(inputPath)) {
  totalLines++
  const src = srcOf(text)
  if (src === undefined) {
    skipped++
    continue
  }
  if (!isScoreboard(src)) {
    const url = /"url":"([^"]*)"/.exec(text.slice(0, 400))?.[1] ?? ''
    const id = DETAIL_ID[src]?.exec(url)?.[1]
    if (id !== undefined) {
      const key = `${src}:${id}`
      const list = detailLines.get(key) ?? []
      list.push({ lineNo: totalLines, t: timeOf(text) ?? '', hasBody: WITH_BODY.test(text) })
      detailLines.set(key, list)
    }
    continue
  }
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

/** Numbers of the game's detail lines to keep: the pick of each feed, per its kept times. */
function detailLineNumbers(g: ReplayGame, kept: ReturnType<typeof sampleScoreboardTimes>) {
  const numbers = new Set<number>()
  let recorded = 0
  for (const [src, id, times] of [
    ['nba-boxscore', g.nbaGameId, kept.nba],
    ['espn-summary', g.espnEventId, kept.espn],
  ] as const) {
    const lines = id === undefined ? [] : (detailLines.get(`${src}:${id}`) ?? [])
    recorded += lines.length
    for (const i of pickDetailLines(lines, times)) {
      const line = lines[i]
      if (line) numbers.add(line.lineNo)
    }
  }
  // Guards WITH_BODY only: if the line head format changed, no line would count as having a body.
  // A DETAIL_ID mismatch leaves `recorded` at 0, so it does not warn.
  if (recorded > 0 && numbers.size === 0) {
    console.error(
      `warning: --raw ${g.away}@${g.home}: ${recorded} detail lines in the recording but none picked (none has a body, or the line format no longer matches WITH_BODY)`,
    )
  }
  return numbers
}

// Pass 2 (only with --raw): stream the sampled lines straight into a gzip file.
async function* rawLinesOf(
  g: ReplayGame,
  count: { scoreboard: number; detail: number },
): AsyncGenerator<string> {
  const kept = sampleScoreboardTimes(g.frames)
  const keptTimes: Record<string, Set<string>> = {
    'nba-scoreboard': new Set(kept.nba),
    'espn-scoreboard': new Set(kept.espn),
  }
  const detail = detailLineNumbers(g, kept)
  let lineNo = 0
  for await (const text of linesOf(inputPath)) {
    lineNo++
    const src = srcOf(text)
    let kind: 'scoreboard' | 'detail'
    if (src !== undefined && isScoreboard(src)) {
      if (unparseable.has(lineNo) || !keptTimes[src]?.has(timeOf(text) ?? '')) continue
      kind = 'scoreboard'
    } else if (detail.has(lineNo)) {
      kind = 'detail'
    } else {
      continue
    }
    let record: Record<string, unknown>
    try {
      record = JSON.parse(text) as Record<string, unknown>
    } catch {
      console.error(`warning: line ${lineNo} (${src}) is not JSON, left out of the raw sample`)
      continue
    }
    count[kind]++
    yield `${JSON.stringify(trimRecord(record))}\n`
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
  const count = { scoreboard: 0, detail: 0 }
  await pipeline(rawLinesOf(g, count), createGzip(), createWriteStream(out))
  console.log(
    `raw/${name}.ndjson.gz: ${statSync(out).size} bytes, ${count.scoreboard} scoreboard + ${count.detail} detail lines`,
  )
}

console.log(
  `read ${totalLines} lines, ${scoreboardLines} scoreboard lines used, ${skipped} skipped (truncated or malformed)`,
)
