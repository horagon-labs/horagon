// History -> chart series. lightweight-charts wants strictly increasing times, so points that
// share a second keep the last one.
import type { GameHistory } from '@horagon/sdk'
import { type RunMarker, scoringRuns } from './format'

export interface Point {
  time: number
  value: number
}

export interface ChartSeries {
  market: Point[]
  model: Point[]
  runs: RunMarker[]
}

function ascending(points: Point[]): Point[] {
  const byTime = new Map<number, number>()
  for (const p of points) byTime.set(p.time, p.value)
  return [...byTime].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }))
}

/**
 * The market line (YES price of `market`), the model line, and the scoring-run markers. Runs
 * sit on the model line, whose points come from the same snapshots, so a marker always has a
 * point at its time.
 */
export function chartSeries(history: GameHistory, market: string): ChartSeries {
  const market_ = ascending(
    history.prices.filter((p) => p.market === market).map((p) => ({ time: p.ts, value: p.price })),
  )
  const modelPoints = history.snapshots.flatMap((s) =>
    s.modelProb === null ? [] : [{ time: s.ts, value: s.modelProb }],
  )
  const model = ascending(modelPoints)
  const times = new Set(model.map((p) => p.time))
  const runs = scoringRuns(history.snapshots).filter((r) => times.has(r.ts))
  return { market: market_, model, runs }
}
