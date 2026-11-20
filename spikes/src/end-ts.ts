// end_ts: when should a winner market close? pm-AMM has no pause and no early resolution, so the
// close is fixed when the market is created. This reads the game timelines that `end-ts:fetch`
// wrote and measures, for each candidate close S + X (S = scheduled tip-off): how many games end
// before it, how much of Q4 is tradable, and how many close games are still open in their last
// minute. The checks are the premises of the S + 2h10m decision (spec 6.1) and of the feed-silent
// watch that starts 30 min before it (spec 6.2); a run on newer games that fails one means the
// decision needs another look.
//
//   pnpm --filter @horagon/spikes end-ts [path/to/espn-games-….json.gz]
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  DATA_DIR,
  type GameTimeline,
  gameStats,
  offsetStats,
  q4Mark,
  quantile,
  startsBeforeSchedule,
} from './lib/end-ts'
import { runSpike, SpikeRun } from './lib/results'

/** The chosen close, minutes after S (spec 6.1: S + 2h10m; keeper DEFAULT_TIMINGS 7_800 s). */
const CHOSEN_MIN = 130
/** The next step up that the decision rejects. */
const REJECTED_MIN = 140
/**
 * From here on, a silent feed alerts the guardian whatever quarter it last showed (spec 6.2;
 * keeper feedSilentWatchSecs 1_800 before end_ts). It must come before any game reaches Q4: an
 * outage that spans the start of Q4 would otherwise go unnoticed.
 */
const WATCH_MIN = CHOSEN_MIN - 30
const OFFSETS_MIN = [115, 125, 130, 135, 140, 145, 150]

const r1 = (x: number) => Math.round(x * 10) / 10
const spread = (xs: readonly number[]) =>
  Object.fromEntries(
    (
      [
        ['min', 0],
        ['p1', 0.01],
        ['p5', 0.05],
        ['p25', 0.25],
        ['p50', 0.5],
        ['p75', 0.75],
        ['p95', 0.95],
        ['max', 1],
      ] as const
    ).map(([k, q]) => [k, r1(quantile(xs, q))]),
  )

/** The data file that reaches the latest game date; of those, the one that starts earliest. */
function latestData(): string {
  const files = readdirSync(DATA_DIR)
    .map((f) => /^espn-games-(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(f))
    .filter((m) => m !== null)
    .sort(
      (a, b) =>
        (a[2] as string).localeCompare(b[2] as string) ||
        (b[1] as string).localeCompare(a[1] as string),
    )
  const last = files.at(-1)?.[0]
  if (!last) throw new Error(`no espn-games-*.json.gz in ${DATA_DIR}: run end-ts:fetch first`)
  return join(DATA_DIR, last)
}

const run = new SpikeRun('end-ts', 'n/a')

await runSpike(run, async () => {
  const file = process.argv[2] ?? latestData()
  const input = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as {
    from: string
    to: string
    fetchedAt: string
    games: GameTimeline[]
  }
  run.record('input', {
    file: basename(file),
    from: input.from,
    to: input.to,
    fetchedAt: input.fetchedAt,
    games: input.games.length,
  })

  const excluded = input.games.filter(startsBeforeSchedule)
  run.record(
    'excluded',
    excluded.map(
      (g) =>
        `${g.date} ${g.name}: first play ${r1(-gameStats(g).tipMin)} min before S (ESPN stamps some games of a DST change day an hour early)`,
    ),
  )
  const games = input.games.filter((g) => !startsBeforeSchedule(g))
  const stats = games.map(gameStats)
  const n = games.length
  run.record('games', { used: n, overtime: stats.filter((s) => s.overtime).length })
  run.record('tipMinutesAfterS', spread(stats.map((s) => s.tipMin)))
  const q4Starts = stats.flatMap((s) => (s.q4StartMin === null ? [] : [s.q4StartMin]))
  run.record('q4StartMinutesAfterS', spread(q4Starts))
  run.record('endMinutesAfterS', spread(stats.map((s) => s.endMin)))
  run.record(
    'endMinutesAfterSRegulation',
    spread(stats.filter((s) => !s.overtime).map((s) => s.endMin)),
  )
  run.record(
    'endMinutesAfterSOvertime',
    spread(stats.filter((s) => s.overtime).map((s) => s.endMin)),
  )

  const offsets = OFFSETS_MIN.map((x) => {
    const o = offsetStats(games, x)
    return {
      ...o,
      closeInQ4OrLaterPct: r1(o.closeInQ4OrLaterPct),
      q4GameMinTradableMedian: r1(o.q4GameMinTradableMedian),
      gameTradableMedianPct: r1(o.gameTradableMedianPct),
      q4WallMinBeforeCloseMedian: r1(o.q4WallMinBeforeCloseMedian),
      pairedEndBeforeClosePct: Math.round(o.pairedEndBeforeClosePct * 100) / 100,
    }
  })
  run.record('offsets', offsets)

  const early = games
    .map((g) => ({ g, s: gameStats(g) }))
    .filter(({ s }) => s.endMin < REJECTED_MIN)
    .sort((a, b) => a.s.endMin - b.s.endMin)
    .map(({ g, s }) => ({
      date: s.date,
      name: s.name,
      endMin: r1(s.endMin),
      finalMargin: s.finalMargin,
      marginAtQ4TwoMinutes: q4Mark(g, 120)?.[1] ?? null,
    }))
  run.record(`gamesEndingBeforeS+${REJECTED_MIN}`, early)
  const decided = early.filter((e) => Math.abs(e.marginAtQ4TwoMinutes ?? 0) >= 6).length
  const absMargin = (pick: (m: number) => boolean) =>
    quantile(
      stats.filter((s) => pick(s.endMin)).map((s) => Math.abs(s.finalMargin)),
      0.5,
    )
  run.record('medianAbsFinalMargin', {
    [`endsBeforeS+${REJECTED_MIN}`]: absMargin((m) => m < REJECTED_MIN),
    'endsAtOrAfterS+150': absMargin((m) => m >= 150),
    all: absMargin(() => true),
  })

  const chosen = offsets.find((o) => o.offsetMin === CHOSEN_MIN)
  const rejected = offsets.find((o) => o.offsetMin === REJECTED_MIN)
  if (!chosen || !rejected) throw new Error('chosen or rejected offset missing')
  run.check(
    'S + 2h10m: at most 1% of games end before the close',
    chosen.endedBeforeClose / n <= 0.01,
    `${chosen.endedBeforeClose} of ${n}`,
  )
  run.check(
    'S + 2h10m: at least 80% of games have reached Q4 at the close',
    chosen.closeInQ4OrLaterPct >= 80,
    `${chosen.closeInQ4OrLaterPct}%, median ${chosen.q4GameMinTradableMedian} Q4 game minutes`,
  )
  run.check(
    'S + 2h10m: no game within 5 points is still open in its last minute',
    chosen.clutchOpen === 0,
    `${chosen.clutchOpen} games`,
  )
  const firstQ4 = quantile(q4Starts, 0)
  run.check(
    'S + 1h40m: no game has reached Q4 when the feed-silent watch starts',
    q4Starts.length === n && firstQ4 > WATCH_MIN,
    `${q4Starts.length} of ${n} games reach Q4, the first at S + ${r1(firstQ4)} min`,
  )
  run.check(
    'S + 2h20m: over 5% of games end before the close, so a later close is rejected',
    rejected.endedBeforeClose / n > 0.05,
    `${rejected.endedBeforeClose} of ${n}`,
  )
  run.check(
    'most games that end before S + 2h20m are decided with 2:00 left in Q4 (6+ points)',
    early.length > 0 && decided / early.length >= 0.8,
    `${decided} of ${early.length}`,
  )
})
