// History -> chart series. lightweight-charts wants strictly increasing times, so points that
// share a second keep the last one.
import type { GameHistory } from '@horagon/sdk'

export interface Point {
  time: number
  value: number
}

export interface ChartSeries {
  market: Point[]
  model: Point[]
}

function ascending(points: Point[]): Point[] {
  const byTime = new Map<number, number>()
  for (const p of points) byTime.set(p.time, p.value)
  return [...byTime].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }))
}

/**
 * The market line (YES price of `market`) and the model line. The Tape's run markers come from
 * lib/chrono/runs.ts and sit on the model line.
 */
export function chartSeries(history: GameHistory, market: string): ChartSeries {
  const market_ = ascending(
    history.prices.filter((p) => p.market === market).map((p) => ({ time: p.ts, value: p.price })),
  )
  const modelPoints = history.snapshots.flatMap((s) =>
    s.modelProb === null ? [] : [{ time: s.ts, value: s.modelProb }],
  )
  return { market: market_, model: ascending(modelPoints) }
}
