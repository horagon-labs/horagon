// Replays games recorded by spike S4 (`tests/fixtures/replay/*.json`) as a live feed, shifted
// so the recorded tip-off lands at a chosen time. Used for the devnet rehearsal (spec 3, Tier 1
// "done") and the Surfpool run. Each rehearsal gets its own `tag`, so its markets never collide
// with real games or an earlier rehearsal. The fixture format and its quirks: `@horagon/sdk/replay`.
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  clockToSecs,
  type ReplayFrame,
  type ReplayGame,
  ReplayGameSchema,
} from '@horagon/sdk/replay'
import type { Feed, FeedGame, FeedSnapshot, FeedStatus } from './types'

export async function loadReplayDir(dir: string): Promise<ReplayGame[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort()
  return Promise.all(
    names.map(async (n) =>
      ReplayGameSchema.parse(JSON.parse(await readFile(join(dir, n), 'utf8'))),
    ),
  )
}

const STATUS: Record<ReplayFrame['status'], FeedStatus> = {
  pre: 'scheduled',
  live: 'live',
  final: 'final',
  postponed: 'postponed',
}

/**
 * Per-period points from the frames seen so far. A frame is written on every score change, so
 * the last frame of period p carries the cumulative score at the end of p.
 */
export function rebuildPeriods(frames: readonly ReplayFrame[]): Array<[number, number]> {
  const endOf = new Map<number, [number, number]>()
  for (const f of frames) if (f.period > 0) endOf.set(f.period, [f.homeScore, f.awayScore])
  const last = Math.max(0, ...endOf.keys())
  const out: Array<[number, number]> = []
  let prev: [number, number] = [0, 0]
  for (let p = 1; p <= last; p++) {
    const cum = endOf.get(p) ?? prev
    out.push([cum[0] - prev[0], cum[1] - prev[1]])
    prev = cum
  }
  return out
}

const easternDate = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d)

export interface ReplayOptions {
  /** Appended to the recorded event id, e.g. "r1"; letters and digits only. */
  tag: string
  /** Where the first fixture's tip-off lands; the others keep their offsets to it. */
  tipoff: Date
  now: () => Date
  /**
   * Game time runs this many times faster than wall time (default 1). Only for the local run
   * on Surfpool; a rehearsal on devnet plays at 1 so it looks like a real night.
   */
  speed?: number
}

export function replayFeed(fixtures: readonly ReplayGame[], opts: ReplayOptions): Feed {
  if (!/^[A-Za-z0-9]{1,6}$/.test(opts.tag)) throw new Error('replay tag: 1-6 letters or digits')
  const first = fixtures[0]
  if (!first) throw new Error('replay: no fixtures')
  const speed = opts.speed ?? 1
  if (!(speed >= 1 && speed <= 60)) throw new Error('replay speed: 1 to 60')
  const origin = new Date(first.tipoffUtc).getTime()
  const at = (iso: string) => opts.tipoff.getTime() + (new Date(iso).getTime() - origin) / speed
  const games = fixtures.map((f) => {
    const source = f.frames.some((x) => x.source === 'espn') ? 'espn' : 'nba'
    const id = `${f.espnEventId ?? f.nbaGameId ?? `${f.away}${f.home}`}${opts.tag}`
    if (id.length > 16) throw new Error(`replay: game id ${id} is longer than 16 characters`)
    const tipoff = new Date(at(f.tipoffUtc))
    return {
      fixture: f,
      externalId: id,
      tipoff,
      gameDate: easternDate(tipoff),
      frames: f.frames.filter((x) => x.source === source).map((x) => ({ ...x, at: at(x.t) })),
    }
  })

  const stateAt = (g: (typeof games)[number], now: number): FeedGame => {
    const seen = g.frames.filter((x) => x.at <= now)
    const frame = seen.at(-1)
    const status = frame ? STATUS[frame.status] : 'scheduled'
    return {
      league: 'NBA',
      externalId: g.externalId,
      gameDate: g.gameDate,
      home: g.fixture.home,
      away: g.fixture.away,
      tipoff: g.tipoff,
      status,
      period: frame?.period ?? 0,
      clockSecs: frame && status === 'live' ? clockToSecs(frame.clock) : null,
      homeScore: frame?.homeScore ?? 0,
      awayScore: frame?.awayScore ?? 0,
      periods: frame?.periods ?? rebuildPeriods(seen),
      cup: false,
    }
  }

  return {
    name: 'replay',
    async fetchDay(gameDate: string): Promise<FeedSnapshot> {
      const now = opts.now()
      return {
        source: 'replay',
        url: `https://horagon.invalid/replay/${opts.tag}/${gameDate}`,
        fetchedAt: now,
        games: games.filter((g) => g.gameDate === gameDate).map((g) => stateAt(g, now.getTime())),
      }
    },
  }
}
