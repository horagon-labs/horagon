'use client'
// The Tape (spec 3.2): lightweight-charts 5.3.0 in Chronometer colors. Market line lume, model
// line brass, a dashed line where each quarter starts (a series primitive, the v5 plugin API),
// run markers from runs.ts (createSeriesMarkers), and the time axis in ET (spec 5.4). Its
// numbers are in JetBrains Mono, like every number on the page.
import type { GameHistory } from '@horagon/sdk'
import {
  createChart,
  createSeriesMarkers,
  type IChartApi,
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
import {
  type PeriodStart,
  periodStarts,
  runMarkers,
  tapeCents,
  tapeTime,
} from '../../lib/chrono/tape'
import { etClock } from '../../lib/chrono/time'
import { COLORS } from '../../lib/chrono/tokens'

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

  /** `font`: the family of the labels, the chart's own. */
  constructor(private readonly font: string) {}

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
      context.font = `11px ${this.font}`
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
  chart: IChartApi
  market: ISeriesApi<'Line'>
  model: ISeriesApi<'Line'>
  markers: ISeriesMarkersPluginApi<Time>
  quarters: QuarterLines
}

const toData = (points: Point[]) =>
  points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
const priceFormat = { type: 'custom' as const, formatter: tapeCents }
// Probabilities: always the whole 0-100¢ range, so a move is never exaggerated.
const fullRange = () => ({ priceRange: { minValue: 0, maxValue: 1 } })
// Room after the last point, so the last " ET" tick label is not cut off at the right edge: about
// half the widest label, in pixels, since fitContent folds a bar offset into the fit (N4).
const RIGHT_OFFSET_PX = 40

/** The family next/font resolved for JetBrains Mono (set on <html>, app/layout.tsx). */
const monoFamily = (): string =>
  getComputedStyle(document.documentElement).getPropertyValue('--font-jetbrains').trim() ||
  'monospace'

export function Tape(props: {
  history: GameHistory | undefined
  market: string
  home: string
  away: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const handles = useRef<Handles | null>(null)
  // The history is fitted to the width once: a later refresh must not undo a pan or a zoom.
  const fitted = useRef(false)

  useEffect(() => {
    if (!box.current) return
    const font = monoFamily()
    const chart = createChart(box.current, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: COLORS['ash-400'],
        fontFamily: font,
      },
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
        rightOffsetPixels: RIGHT_OFFSET_PX,
        // The one fit holds across a resize (a rotated phone, a wider window), and so does a
        // range the user panned or zoomed to.
        lockVisibleTimeRangeOnResize: true,
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
    const quarters = new QuarterLines(font)
    market.attachPrimitive(quarters)
    handles.current = { chart, market, model, markers: createSeriesMarkers(model, []), quarters }
    fitted.current = false
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
    if (!fitted.current && (s.market.length > 0 || s.model.length > 0)) {
      h.chart.timeScale().fitContent()
      fitted.current = true
    }
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
