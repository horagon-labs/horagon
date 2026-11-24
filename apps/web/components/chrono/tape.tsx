'use client'
// The Tape (spec 3.2): lightweight-charts 5.3.0 in Chronometer colors. Market line lume, model
// line brass, a dashed line where each quarter starts (a series primitive, the v5 plugin API),
// run markers from runs.ts (createSeriesMarkers), and the time axis in ET (spec 5.4).
import type { GameHistory } from '@horagon/sdk'
import {
  createChart,
  createSeriesMarkers,
  type IPrimitivePaneRenderer,
  type IPrimitivePaneView,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type ISeriesPrimitive,
  LineSeries,
  type SeriesAttachedParameter,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import { useEffect, useRef } from 'react'
import { chartSeries, type Point } from '../../lib/chart'
import { findRuns } from '../../lib/chrono/runs'
import { type PeriodStart, periodStarts, runMarkers, tapeTime } from '../../lib/chrono/tape'
import { etClock } from '../../lib/chrono/time'
import { COLORS } from '../../lib/chrono/tokens'
import { cents } from '../../lib/format'

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0]

/** Dashed vertical lines with "Q2", "Q3"... at each period start, drawn under the lines. */
class QuarterLines implements ISeriesPrimitive<Time> {
  private chart: SeriesAttachedParameter<Time>['chart'] | null = null
  private requestUpdate: (() => void) | null = null
  private starts: readonly PeriodStart[] = []
  private readonly view: IPrimitivePaneView = {
    zOrder: () => 'bottom',
    renderer: () => ({ draw: (target: Target) => this.draw(target) }),
  }

  attached(p: SeriesAttachedParameter<Time>): void {
    this.chart = p.chart
    this.requestUpdate = p.requestUpdate
  }

  detached(): void {
    this.chart = null
    this.requestUpdate = null
  }

  setStarts(starts: readonly PeriodStart[]): void {
    this.starts = starts
    this.requestUpdate?.()
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this.view]
  }

  private draw(target: Target): void {
    const chart = this.chart
    if (!chart) return
    // biome-ignore lint/correctness/useHookAtTopLevel: fancy-canvas's drawing scope, not a hook
    target.useMediaCoordinateSpace(({ context, mediaSize }) => {
      context.save()
      context.strokeStyle = COLORS['brass-700']
      context.fillStyle = COLORS['ash-400']
      context.font = '10px monospace'
      context.setLineDash([3, 3])
      for (const s of this.starts) {
        const x = chart.timeScale().timeToCoordinate(s.ts as UTCTimestamp)
        if (x === null) continue
        context.beginPath()
        context.moveTo(x, 0)
        context.lineTo(x, mediaSize.height)
        context.stroke()
        context.fillText(s.label, x + 3, 12)
      }
      context.restore()
    })
  }
}

interface Handles {
  market: ISeriesApi<'Line'>
  model: ISeriesApi<'Line'>
  markers: ISeriesMarkersPluginApi<Time>
  quarters: QuarterLines
}

const toData = (points: Point[]) =>
  points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
const priceFormat = { type: 'custom' as const, formatter: (p: number) => cents(p) }
// Probabilities: always the whole 0-100¢ range, so a move is never exaggerated.
const fullRange = () => ({ priceRange: { minValue: 0, maxValue: 1 } })

export function Tape(props: {
  history: GameHistory | undefined
  market: string
  home: string
  away: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const handles = useRef<Handles | null>(null)

  useEffect(() => {
    if (!box.current) return
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: COLORS['ash-400'] },
      grid: { vertLines: { visible: false }, horzLines: { color: COLORS.line } },
      crosshair: {
        vertLine: { color: COLORS['brass-700'] },
        horzLine: { color: COLORS['brass-700'] },
      },
      localization: { timeFormatter: (t: Time) => etClock(tapeTime(t)) },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: COLORS.line,
        tickMarkFormatter: (t: Time) => etClock(tapeTime(t)),
      },
      rightPriceScale: { borderColor: COLORS.line, scaleMargins: { top: 0.05, bottom: 0.05 } },
    })
    const line = { priceFormat, autoscaleInfoProvider: fullRange }
    const market = chart.addSeries(LineSeries, { ...line, color: COLORS['lume-300'], lineWidth: 2 })
    const model = chart.addSeries(LineSeries, {
      ...line,
      color: COLORS['brass-500'],
      lineWidth: 1,
      lineStyle: 2,
    })
    const quarters = new QuarterLines()
    market.attachPrimitive(quarters)
    handles.current = { market, model, markers: createSeriesMarkers(model, []), quarters }
    return () => {
      chart.remove()
      handles.current = null
    }
  }, [])

  useEffect(() => {
    const h = handles.current
    if (!h || !props.history) return
    const s = chartSeries(props.history, props.market)
    h.market.setData(toData(s.market))
    h.model.setData(toData(s.model))
    h.quarters.setStarts(periodStarts(props.history.snapshots))
    const times = new Set(s.model.map((p) => p.time))
    const teams = { home: props.home, away: props.away }
    h.markers.setMarkers(
      runMarkers(findRuns(props.history, props.market), teams, times).map((m) => ({
        ...m,
        time: m.time as UTCTimestamp,
      })),
    )
  }, [props.history, props.market, props.home, props.away])

  return (
    <figure>
      <div ref={box} className="h-56 w-full" />
      <figcaption className="mt-1 flex flex-wrap gap-x-4 font-mono text-11 text-ash-400">
        <span className="text-lume-300">━ Market ({props.home} wins)</span>
        <span className="text-brass-500">┅ Model</span>
        <span>Times in ET</span>
      </figcaption>
    </figure>
  )
}
