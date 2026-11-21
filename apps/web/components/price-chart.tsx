'use client'
// Market (YES = home) and model lines, with a marker at each 8-0 scoring run (spec 10).
import type { GameHistory } from '@horagon/sdk'
import {
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  LineSeries,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import { useEffect, useRef } from 'react'
import { chartSeries, type Point } from '../lib/chart'
import { cents } from '../lib/format'

interface Handles {
  chart: IChartApi
  market: ISeriesApi<'Line'>
  model: ISeriesApi<'Line'>
  markers: ISeriesMarkersPluginApi<Time>
}

const toData = (points: Point[]) =>
  points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }))
const priceFormat = { type: 'custom' as const, formatter: (p: number) => cents(p) }
// Probabilities: always show the whole 0-100¢ range so a move is never exaggerated.
const fullRange = () => ({ priceRange: { minValue: 0, maxValue: 1 } })

export function PriceChart(props: {
  history: GameHistory | undefined
  market: string
  home: string
  away: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const handles = useRef<Handles | null>(null)

  useEffect(() => {
    if (!box.current) return
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: dark ? '#a1a1aa' : '#52525b' },
      grid: { vertLines: { visible: false }, horzLines: { color: dark ? '#27272a' : '#e4e4e7' } },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { scaleMargins: { top: 0.05, bottom: 0.05 } },
    })
    const line = { priceFormat, autoscaleInfoProvider: fullRange }
    const market = chart.addSeries(LineSeries, { ...line, color: '#2563eb', lineWidth: 2 })
    const model = chart.addSeries(LineSeries, {
      ...line,
      color: '#a1a1aa',
      lineWidth: 1,
      lineStyle: 2,
    })
    handles.current = { chart, market, model, markers: createSeriesMarkers(model, []) }
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
    h.markers.setMarkers(
      s.runs.map((r) => ({
        time: r.ts as UTCTimestamp,
        position: 'aboveBar' as const,
        shape: 'arrowDown' as const,
        color: r.team === 'home' ? '#2563eb' : '#dc2626',
        text: `${r.team === 'home' ? props.home : props.away} ${r.points}-0`,
      })),
    )
  }, [props.history, props.market, props.home, props.away])

  return (
    <figure>
      <div ref={box} className="h-56 w-full" />
      <figcaption className="mt-1 flex gap-4 text-xs text-zinc-500">
        <span className="text-home">━ Market ({props.home} wins)</span>
        <span>┅ Model</span>
      </figcaption>
    </figure>
  )
}
