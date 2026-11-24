// Scoring runs (spec 3.1): one team scores at least 8 unanswered points within 3 minutes of
// real time. One run per streak, the best 3-minute stretch of it, with the market's price at
// its start and end from history.prices.
import type { GameHistory } from '@horagon/sdk'
import { whole } from '../format'

export const RUN_POINTS = 8
export const RUN_SECS = 180

export interface Run {
  team: 'home' | 'away'
  /**
   * Unix seconds of the streak's first basket. Unlike `from`, it never moves while the streak
   * grows, so it names the run (the Dial flashes once per run, spec 2.4).
   */
  start: number
  /** Unix seconds of the first and last basket of the stretch. */
  from: number
  to: number
  points: number
  /** The home side's (YES) price at or before `from` and `to`; null without one. */
  priceFrom: number | null
  priceTo: number | null
}

interface Basket {
  ts: number
  points: number
}

/** The last price at or before `ts`, or null. */
function priceAt(prices: readonly { ts: number; price: number }[], ts: number): number | null {
  let best: { ts: number; price: number } | undefined
  for (const p of prices) if (p.ts <= ts && (!best || p.ts >= best.ts)) best = p
  return best?.price ?? null
}

/** The stretch of a streak with the most points inside RUN_SECS, earliest on a tie. */
function bestStretch(baskets: readonly Basket[]): { from: number; to: number; points: number } {
  let best = { from: 0, to: 0, points: 0 }
  baskets.forEach((last, end) => {
    let points = 0
    let from = last.ts
    // Walk back from this basket while the stretch still fits in 3 minutes.
    for (const b of baskets.slice(0, end + 1).reverse()) {
      if (b.ts < last.ts - RUN_SECS) break
      points += b.points
      from = b.ts
    }
    if (points > best.points) best = { from, to: last.ts, points }
  })
  return best
}

export function findRuns(history: GameHistory, market: string): Run[] {
  const prices = history.prices.filter((p) => p.market === market).sort((a, b) => a.ts - b.ts)
  const snaps = [...history.snapshots].sort((a, b) => a.ts - b.ts)
  const runs: Run[] = []
  let team: Run['team'] | null = null
  let streak: Basket[] = []
  const close = () => {
    const first = streak[0]
    if (team === null || first === undefined) return
    const s = bestStretch(streak)
    if (s.points >= RUN_POINTS) {
      runs.push({
        team,
        start: first.ts,
        ...s,
        priceFrom: priceAt(prices, s.from),
        priceTo: priceAt(prices, s.to),
      })
    }
  }
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1]
    const cur = snaps[i]
    if (!prev || !cur) continue
    const dh = cur.homeScore - prev.homeScore
    const da = cur.awayScore - prev.awayScore
    if (dh <= 0 && da <= 0) continue
    // Both scored between two snapshots: neither run was unanswered.
    const scorer = dh > 0 && da > 0 ? null : dh > 0 ? 'home' : 'away'
    if (scorer !== team || scorer === null) {
      close()
      team = scorer
      streak = []
    }
    if (scorer !== null) streak.push({ ts: cur.ts, points: Math.max(dh, da) })
  }
  close()
  return runs
}

/** "CLE on an 8–0 run · price 74 → 77 in 2 min" (spec 3.2), prices on the running side. */
export function runLine(run: Run, teams: { home: string; away: string }): string {
  // The running side's price in whole cents, "<1" and ">99" at the edges (see format.ts).
  const side = (p: number | null) =>
    p === null ? null : whole(run.team === 'home' ? p : 1 - p, '')
  const mins = Math.max(1, Math.round((run.to - run.from) / 60))
  const from = side(run.priceFrom)
  const to = side(run.priceTo)
  // "an 8", "an 11", "an 18", "an 80"; "a" before every other count.
  const article = /^(8|11|18)/.test(String(run.points)) ? 'an' : 'a'
  const head = `${teams[run.team]} on ${article} ${run.points}–0 run`
  return from === null || to === null ? head : `${head} · price ${from} → ${to} in ${mins} min`
}

/** The newest run, for the Scorebug's line and the Dial's amber flash key. */
export const latestRun = (runs: readonly Run[]): Run | null => runs.at(-1) ?? null
