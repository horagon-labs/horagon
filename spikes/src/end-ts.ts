// end_ts: when should a winner market close? pm-AMM has no pause and no early resolution, so the
// latest close is fixed when the market is created. Since 2026-11-26 the real close is the final
// buzzer: the keeper halts a market on its first Final read before end_ts, and end_ts is only the
// latest the market can stay open. This reads the game timelines that `end-ts:fetch` wrote and
// measures, for each candidate end_ts S + X (S = scheduled tip-off): how many games end before it
// (closed by the Final halt), how many are still being played (closed early), how much of Q4 is
// tradable, and how many close games are still open in their last minute. The checks are the
// premises of the S + 3h00m decision and of the feed-silent watch from S + 1h40m (spec 6.2); a
// run on newer games that fails one means the decision needs another look.
//
//   pnpm --filter @horagon/spikes end-ts [path/to/espn-games-….json.gz ...]
//
// With no path it reads every espn-games-*.json.gz in spikes/data, merged by game id.
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  DATA_DIR,
  type GameData,
  gameStats,
  isCloseGame,
  mergeGames,
  offsetStats,
  quantile,
  smallestClose,
  startsBeforeSchedule,
  stateAt,
} from './lib/end-ts'
import { runSpike, SpikeRun } from './lib/results'

/** The chosen end_ts, minutes after S (keeper DEFAULT_TIMINGS endOffsetSecs 10_800 s). */
const CHOSEN_MIN = 180
/** At most this share of games may still be in play at end_ts (their market closes early). */
const MAX_LATE_SHARE = 0.03
/**
 * From here on, a silent feed alerts the guardian whatever quarter it last showed (spec 6.2;
 * keeper feedSilentWatchSecs 4_800 before end_ts, so S + 1h40m). It must come before any game
 * reaches Q4: an outage that spans the start of Q4 would otherwise go unnoticed.
 */
const WATCH_MIN = 100
/** The close of 2026-11-19 (S + 2h10m), kept as the baseline row. */
const OLD_MIN = 130
const OFFSETS_MIN = [OLD_MIN, 150, 155, 160, 165, 170, 175, 180]

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
const hm = (min: number) => `S + ${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`

/** Every fetched data file, in name order. */
function dataFiles(): string[] {
  const files = readdirSync(DATA_DIR)
    .filter((f) => /^espn-games-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f))
    .sort()
  if (files.length === 0)
    throw new Error(`no espn-games-*.json.gz in ${DATA_DIR}: run end-ts:fetch first`)
  return files.map((f) => join(DATA_DIR, f))
}

const run = new SpikeRun('end-ts', 'n/a')

await runSpike(run, async () => {
  const files = process.argv.length > 2 ? process.argv.slice(2) : dataFiles()
  const inputs = files.map(
    (file) => JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as GameData,
  )
  run.record(
    'input',
    inputs.map((input, i) => ({
      file: basename(files[i] as string),
      from: input.from,
      to: input.to,
      fetchedAt: input.fetchedAt,
      games: input.games.length,
    })),
  )
  const all = mergeGames(inputs)

  const excluded = all.filter(startsBeforeSchedule)
  run.record(
    'excluded',
    excluded.map(
      (g) =>
        `${g.date} ${g.name}: first play ${r1(-gameStats(g).tipMin)} min before S (ESPN stamps some games of a DST change day an hour early)`,
    ),
  )
  const games = all.filter((g) => !startsBeforeSchedule(g))
  const stats = games.map(gameStats)
  const n = games.length
  run.record('games', {
    used: n,
    overtime: stats.filter((s) => s.overtime).length,
    close: games.filter(isCloseGame).length,
  })
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
      endedAfterClosePct: r1((100 * o.endedAfterClose) / n),
      closeInQ4OrLaterPct: r1(o.closeInQ4OrLaterPct),
      q4GameMinTradableMedian: r1(o.q4GameMinTradableMedian),
      q4GameMinTradableP10: r1(o.q4GameMinTradableP10),
      gameTradableMedianPct: r1(o.gameTradableMedianPct),
      q4WallMinBeforeCloseMedian: r1(o.q4WallMinBeforeCloseMedian),
      pairedEndBeforeClosePct: Math.round(o.pairedEndBeforeClosePct * 100) / 100,
    }
  })
  run.record('offsets', offsets)
  const smallest = smallestClose(
    offsets.filter((o) => o.offsetMin !== OLD_MIN),
    n,
    MAX_LATE_SHARE,
  )
  run.record('smallestCloseMin', smallest)

  // The games still in play at the chosen end_ts, whose market closes before the buzzer.
  const late = games
    .map((g) => ({ g, s: gameStats(g) }))
    .filter(({ s }) => s.endMin > CHOSEN_MIN)
    .sort((a, b) => a.s.endMin - b.s.endMin)
    .map(({ g, s }) => {
      const at = stateAt(g, Date.parse(g.scheduled) + CHOSEN_MIN * 60_000)
      return {
        date: s.date,
        name: s.name,
        endMin: r1(s.endMin),
        overtime: s.overtime,
        finalMargin: s.finalMargin,
        atClose: at ? { period: at[1], clockSecs: at[2], margin: at[3] - at[4] } : null,
      }
    })
  run.record(`gamesEndingAfter${hm(CHOSEN_MIN).replaceAll(' ', '')}`, late)

  const chosen = offsets.find((o) => o.offsetMin === CHOSEN_MIN)
  const earlier = offsets.find((o) => o.offsetMin === CHOSEN_MIN - 5)
  if (!chosen || !earlier) throw new Error('chosen or earlier offset missing')
  run.check(
    `${hm(CHOSEN_MIN)}: at most 3% of games are still being played at end_ts`,
    chosen.endedAfterClose <= MAX_LATE_SHARE * n,
    `${chosen.endedAfterClose} of ${n} (${chosen.endedAfterClosePct}%)`,
  )
  run.check(
    `${hm(CHOSEN_MIN - 5)}: over 3% are, so ${hm(CHOSEN_MIN)} is the smallest close that meets the bar`,
    earlier.endedAfterClose > MAX_LATE_SHARE * n && smallest === CHOSEN_MIN,
    `${earlier.endedAfterClose} of ${n} (${earlier.endedAfterClosePct}%)`,
  )
  const firstQ4 = quantile(q4Starts, 0)
  run.check(
    `${hm(WATCH_MIN)}: no game has reached Q4 when the feed-silent watch starts`,
    q4Starts.length === n && firstQ4 > WATCH_MIN,
    `${q4Starts.length} of ${n} games reach Q4, the first at S + ${r1(firstQ4)} min`,
  )
})
