// The Practice runs (R8): each replays one recorded game of tests/fixtures/replay at 6x as a
// PRACTICE game with its own tag, cycling through the 12 recordings, so its market id never
// collides with an earlier run. Nothing counts a PRACTICE market (docs/metrics.md counts NBA).
import { fileURLToPath } from 'node:url'
import type { ScheduledGame } from '@horagon/db'
import type { ReplayGame } from '@horagon/sdk/replay'
import { p0For, type Ratings } from '../elo'
import { replayFeed } from '../feeds/replay'
import { easternDate, type Feed, type FeedSnapshot, gameIdOf } from '../feeds/types'
import type { SeedPolicy, Timings } from '../planner'

/** Game time runs this many times faster than wall time. */
export const PRACTICE_SPEED = 6
/** A run's market opens at its start; the replayed tip-off comes this long after. */
export const PRACTICE_LEAD_SECS = 600
/** 300 mUSDC for every Practice market. */
export const PRACTICE_SEED = 300_000_000n
export const PRACTICE_SEEDS: SeedPolicy = { featured: PRACTICE_SEED, regular: PRACTICE_SEED }
/** The committed recordings. */
export const PRACTICE_FIXTURES_DIR = fileURLToPath(
  new URL('../../../../tests/fixtures/replay', import.meta.url),
)
/** The feed keeps playing a run this long after its tip-off; a run is over well before. */
const RUN_MEMORY_SECS = 6 * 3600

/**
 * Every timing divided by `speed`, rounded up: end_ts = S' + 10,800 / 6 = S' + 1,800. Each field
 * is listed, so a new field in Timings fails the typecheck here instead of staying unscaled.
 */
export function scaleTimings(t: Timings, speed: number): Timings {
  const s = (v: number) => Math.ceil(v / speed)
  return {
    createLeadSecs: s(t.createLeadSecs),
    endOffsetSecs: s(t.endOffsetSecs),
    createGraceSecs: s(t.createGraceSecs),
    finalStableSecs: s(t.finalStableSecs),
    feedSilentAlertSecs: s(t.feedSilentAlertSecs),
    feedSilentSecs: s(t.feedSilentSecs),
    feedSilentWatchSecs: s(t.feedSilentWatchSecs),
    notStartedSecs: s(t.notStartedSecs),
    postponedResolveSecs: s(t.postponedResolveSecs),
    missingSourceSecs: s(t.missingSourceSecs),
    secondSourceWaitSecs: s(t.secondSourceWaitSecs),
  }
}

/** Run n's replay tag: "p" and n in base 36, so it starts with a letter (replayFeed's rule). */
export const tagFor = (n: number) => `p${n.toString(36)}`

/** `<espn event id><tag>` back to its parts, or null for an id no run wrote. */
export function runOf(externalId: string): { eventId: string; tag: string } | null {
  const m = /^(\d+)(p[0-9a-z]{1,5})$/.exec(externalId)
  return m?.[1] && m[2] ? { eventId: m[1], tag: m[2] } : null
}

/** A recording's public link: its file name in tests/fixtures/replay. */
export const fixtureUrl = (base: string, f: Pick<ReplayGame, 'gameDate' | 'home' | 'away'>) =>
  `${base}/${f.gameDate}-${f.away}-at-${f.home}.json`

export interface PracticeRunInput {
  /** Practice games so far: this run's number. It picks the recording (n mod 12) and the tag. */
  n: number
  /** Unix seconds: the run starts now and tips off PRACTICE_LEAD_SECS later. */
  now: number
  /** loadReplayDir's order (by file name). */
  fixtures: readonly ReplayGame[]
  ratings: Ratings
}

/** The games row of run `n`: its market opens at once (S' - 10 min). */
export function practiceRun(i: PracticeRunInput): ScheduledGame {
  if (i.fixtures.length === 0) throw new Error('practice: no recordings')
  const fixture = i.fixtures[i.n % i.fixtures.length]
  if (!fixture?.espnEventId) throw new Error('practice: a recording without an ESPN event id')
  const externalId = `${fixture.espnEventId}${tagFor(i.n)}`
  if (externalId.length > 16)
    throw new Error(`practice: game id ${externalId} is longer than 16 characters`)
  const tipoff = new Date((i.now + PRACTICE_LEAD_SECS) * 1000)
  return {
    id: gameIdOf({ league: 'PRACTICE', externalId }),
    league: 'PRACTICE',
    externalId,
    gameDate: easternDate(tipoff),
    home: fixture.home,
    away: fixture.away,
    scheduledTipoff: tipoff,
    status: 'scheduled',
    p0: p0For(i.ratings, fixture.home, fixture.away),
  }
}

/**
 * PRACTICE_SOURCE_URL: where anyone can read a recording, the public URL of the repo's
 * tests/fixtures/replay folder. The repo's address lives only in the environment, never in code.
 * https, no trailing slash.
 */
export function practiceSourceUrl(raw: string | undefined): string {
  if (!raw) throw new Error('PRACTICE_SOURCE_URL is not set: Practice evidence links the recording')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('PRACTICE_SOURCE_URL is not a URL')
  }
  if (url.protocol !== 'https:') throw new Error('PRACTICE_SOURCE_URL must be https')
  return url.href.replace(/\/+$/, '')
}

/** A run as the games table has it. */
export interface PracticeRunRow {
  externalId: string
  scheduledTipoff: Date
}

/**
 * The Practice process's feed: one replayFeed per run (league PRACTICE, 6x, the run's tag,
 * shifted to its tip-off), merged. Each game names its recording's public file, which a draft
 * then cites as the `replay` source.
 */
export class PracticeFeed implements Feed {
  readonly name = 'practice'
  private runs: Array<{ key: string; feed: Feed }> = []

  constructor(
    private readonly o: { fixtures: readonly ReplayGame[]; now: () => Date; sourceBase: string },
  ) {}

  /** The runs to play: the PRACTICE rows of the last 6 h. A run already playing is kept as is. */
  setRuns(rows: readonly PracticeRunRow[]): void {
    const since = this.o.now().getTime() - RUN_MEMORY_SECS * 1000
    const next: Array<{ key: string; feed: Feed }> = []
    for (const r of rows) {
      if (r.scheduledTipoff.getTime() < since) continue
      const key = `${r.externalId}@${r.scheduledTipoff.toISOString()}`
      const known = this.runs.find((x) => x.key === key)
      if (known) {
        next.push(known)
        continue
      }
      const run = runOf(r.externalId)
      const fixture = run && this.o.fixtures.find((f) => f.espnEventId === run.eventId)
      if (!run || !fixture) continue
      next.push({
        key,
        feed: replayFeed([fixture], {
          tag: run.tag,
          tipoff: r.scheduledTipoff,
          now: this.o.now,
          speed: PRACTICE_SPEED,
          league: 'PRACTICE',
          sourceUrlOf: (f) => fixtureUrl(this.o.sourceBase, f),
        }),
      })
    }
    this.runs = next
  }

  async fetchDay(gameDate: string): Promise<FeedSnapshot> {
    const snaps = await Promise.all(this.runs.map((r) => r.feed.fetchDay(gameDate)))
    return {
      source: 'replay',
      url: this.o.sourceBase,
      fetchedAt: this.o.now(),
      skipped: 0,
      games: snaps.flatMap((s) => s.games),
    }
  }
}
