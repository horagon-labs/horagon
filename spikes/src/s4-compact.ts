// Spike S4 (compact): turns a raw recording into one replay fixture per game, with a frame
// whenever a feed's status, period, clock or score changes. Games are matched across feeds by
// tricodes (AWAY@HOME); either feed alone is enough. `--raw <AWAY@HOME>` also keeps that game's
// raw lines, gzipped, for parser tests.
//   pnpm --filter @horagon/spikes s4:compact recordings/2026-11-20.ndjson [--raw NYK@TOR]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
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
const keepRaw = new Set(rest.filter((_, i) => rest[i - 1] === '--raw'))

const lines = readFileSync(resolve(input), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as RawLine)

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

for (const line of lines) {
  if (line.body == null) continue
  if (line.src === 'nba-scoreboard') {
    for (const n of (line.body as NbaScoreboard).scoreboard?.games ?? []) {
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
    for (const e of (line.body as EspnScoreboard).events ?? []) {
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

mkdirSync(join(REPLAY_DIR, 'raw'), { recursive: true })
for (const [key, g] of games) {
  const name = `${g.gameDate}-${g.away}-at-${g.home}`
  writeFileSync(join(REPLAY_DIR, `${name}.json`), `${JSON.stringify(g, null, 1)}\n`)
  console.log(`${name}.json: ${g.frames.length} frames`)
  if (keepRaw.has(key)) {
    const mine = (l: RawLine) =>
      (l.src !== 'nba-boxscore' || (g.nbaGameId !== undefined && l.url.includes(g.nbaGameId))) &&
      (l.src !== 'espn-summary' || (g.espnEventId !== undefined && l.url.endsWith(g.espnEventId)))
    const gz = gzipSync(
      lines
        .filter(mine)
        .map((l) => JSON.stringify(l))
        .join('\n'),
    )
    writeFileSync(join(REPLAY_DIR, 'raw', `${name}.ndjson.gz`), gz)
    console.log(`raw/${name}.ndjson.gz: ${gz.length} bytes`)
  }
}
