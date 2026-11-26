'use client'
// The Night dial (spec 3.2, 4.1): tonight on one 12-hour ET face, one arc per game on the ring
// tracks.ts picks. The picture is hidden; a listbox of sr-only options carries the same games.
import { type KeyboardEvent, type MouseEvent, useId, useState } from 'react'
import { type BoardItem, itemLabel, rowWords } from '../../lib/chrono/board'
import { arcPath, etClockAngle, polar } from '../../lib/chrono/geometry'
import { keyStep } from '../../lib/chrono/keys'
import { isTrading } from '../../lib/chrono/state'
import {
  labelIds,
  labelSpots,
  packTracks,
  RING_STEP,
  ringRadius,
  segmentAngles,
  segments,
} from '../../lib/chrono/tracks'
import { stateLine } from './dial-look'

const C = 100
// The readout's hub, inside ring 7 (r = 37, whose lit stroke edge is 34.5).
const HUB = 33
const HOURS = Array.from({ length: 12 }, (_, h) => h)

/**
 * One meaning for live (light branding review §3.2, §4.4): an open market, before tip-off too,
 * closing included, is live; a halt is ink; everything else (no market yet, a game that started
 * with none, trading stopped, a result) is muted. Yours is the ◆ on the label, not the arc.
 */
function arcClass(item: BoardItem): string {
  if (item.state === 'halted') return 'stroke-amber-400'
  if (item.market && isTrading(item.state)) return 'stroke-live'
  return 'stroke-ash-400'
}

/**
 * Width carries what alpha used to (review §4.4): the past thin (1.5) instead of faded, the time
 * ahead 3.5, a closing arc 4.5, and a lit one (hovered or selected) 1.5 more: darker by weight,
 * never lighter.
 */
function arcWidth(item: BoardItem, past: boolean, lit: boolean): number {
  const base = past ? 1.5 : item.state === 'closing' ? 4.5 : 3.5
  return lit ? base + 1.5 : base
}

/** A halt is hatched `3 3`, like its dial ring; the stretch before tip-off is dotted `2 2.5`. */
const arcDash = (item: BoardItem, pre: boolean): string | undefined =>
  item.state === 'halted' ? '3 3' : pre ? '2 2.5' : undefined

export function NightDial(p: {
  items: readonly BoardItem[]
  now: number
  selectedId: string | null
  onSelect: (id: string) => void
  /** The game hovered or focused here or in the list: its arc lights up (spec 4.1). */
  hoverId?: string | null
  onHover?: (id: string | null) => void
  /** The face's words when no arc is drawn (spec 4.4). */
  emptyText: string
  /** Polls failing: a thin red line on the bezel (spec 4.4). */
  stale?: boolean
  className?: string
}) {
  const id = useId()
  const [active, setActive] = useState<string | null>(null)
  const { tracks, overflow } = packTracks(p.items, p.now)
  // Arrow keys walk the arcs by closing time (spec 3.2).
  const order = [...tracks].sort((a, b) => a.item.interval.end - b.item.interval.end)
  const index = Math.max(
    0,
    order.findIndex((t) => t.item.id === (active ?? p.selectedId)),
  )
  const hover = p.hoverId ?? null
  const ids = labelIds(tracks, { selectedId: p.selectedId, hoverId: hover, now: p.now })
  const spots = labelSpots(tracks, ids, p.now)
  const focus = tracks.find((t) => t.item.id === ids[0])?.item
  const focusWords = focus ? rowWords(focus) : null
  const angle = etClockAngle(p.now)
  const hand = polar(C, C, 92, angle)
  const hub = polar(C, C, HUB, angle)

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const current = order[index]
    if ((e.key === 'Enter' || e.key === ' ') && current) {
      e.preventDefault()
      p.onSelect(current.item.id)
      return
    }
    const next = order[keyStep(e.key, index, order.length, 'list') ?? -1]
    if (!next) return
    e.preventDefault()
    setActive(next.item.id)
    p.onHover?.(next.item.id)
  }

  function onClick(e: MouseEvent<HTMLDivElement>) {
    const hit = (e.target as Element).closest('[data-id]')?.getAttribute('data-id')
    if (hit) p.onSelect(hit)
  }

  return (
    <div
      role="listbox"
      tabIndex={0}
      aria-label="Tonight on the clock"
      aria-activedescendant={order.length > 0 ? `${id}-${index}` : undefined}
      onKeyDown={onKeyDown}
      onClick={onClick}
      onBlur={() => {
        setActive(null)
        p.onHover?.(null)
      }}
      className={`relative aspect-square w-full rounded-full ${p.className ?? ''}`}
    >
      <svg viewBox="0 0 200 200" aria-hidden="true" className="absolute inset-0 size-full">
        {/* A white face in a brass case (light branding review §4.4). */}
        <circle
          cx={C}
          cy={C}
          r={97}
          strokeWidth={1.5}
          className="fill-enamel-900 stroke-brass-700"
        />
        {p.stale && (
          <path
            d={arcPath(C, C, 97, -40, 40)}
            fill="none"
            strokeWidth={1.5}
            className="stroke-red-400"
            data-stale
          />
        )}
        {HOURS.map((h) => {
          const o = polar(C, C, 95, h * 30)
          const i = polar(C, C, h % 3 === 0 ? 89 : 92, h * 30)
          return (
            <line
              key={h}
              x1={o.x}
              y1={o.y}
              x2={i.x}
              y2={i.y}
              strokeWidth={h % 3 === 0 ? 1.5 : 1}
              className="stroke-brass-700"
            />
          )
        })}
        {tracks.map((t) =>
          segments(t, p.now).map((s) => {
            const a = segmentAngles(s, p.now)
            const lit = t.item.id === hover || t.item.id === p.selectedId
            const d = arcPath(C, C, ringRadius(t.ring), a.from, a.to)
            return (
              <g key={`${t.item.id}-${s.from}`}>
                <path
                  d={d}
                  fill="none"
                  strokeWidth={arcWidth(t.item, s.past, lit)}
                  strokeDasharray={arcDash(t.item, s.pre)}
                  className={arcClass(t.item)}
                  pointerEvents="none"
                />
                {/* A full ring pitch wide, so a thumb can hit it (neighbours never overlap). */}
                <path
                  d={d}
                  fill="none"
                  stroke="transparent"
                  strokeWidth={RING_STEP}
                  pointerEvents="stroke"
                  data-hit
                  data-id={t.item.id}
                  data-ring={t.ring}
                  onPointerEnter={() => p.onHover?.(t.item.id)}
                  onPointerLeave={() => p.onHover?.(null)}
                />
              </g>
            )
          }),
        )}
        {spots.map((s) => {
          const item = tracks.find((t) => t.item.id === s.id)?.item
          return (
            <text
              key={s.id}
              x={s.x}
              y={s.y}
              textAnchor={s.anchor}
              dominantBaseline="middle"
              className="fill-ivory-100 font-mono text-[8px]"
            >
              {item?.held && <tspan className="fill-live">◆ </tspan>}
              {item?.game.home}
            </text>
          )
        })}
        <circle
          cx={C}
          cy={C}
          r={HUB}
          fill="none"
          strokeWidth={0.75}
          className="stroke-rule-faint"
          data-hub
        />
        <line
          x1={hub.x}
          y1={hub.y}
          x2={hand.x}
          y2={hand.y}
          strokeWidth={1.5}
          strokeLinecap="round"
          className="stroke-ivory-100"
          data-now
        />
        {overflow.length > 0 && (
          <text
            x={C}
            y={C + 28}
            textAnchor="middle"
            className="fill-ash-400 font-mono text-[9px]"
            data-overflow={overflow.length}
          >
            +{overflow.length}
          </text>
        )}
      </svg>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-0.5 text-center"
      >
        <div className="flex max-w-[32%] flex-col items-center gap-0.5 text-center">
          {focus && focusWords ? (
            <>
              <span className="text-12 uppercase tracking-[0.16em] text-brass-500">
                {focus.game.away} @ {focus.game.home}
              </span>
              {focusWords.value && (
                <span className="font-mono text-24 text-ivory-100 tabular-nums">
                  {focusWords.value}
                </span>
              )}
              {focusWords.subject && (
                <span className="text-12 text-brass-400">{focusWords.subject}</span>
              )}
              <span className="font-mono text-12 text-ash-400">
                {stateLine(focus.state, focus.game, focus.secsLeft, p.now)}
              </span>
            </>
          ) : (
            <span className="text-13 text-ash-400">{p.emptyText}</span>
          )}
        </div>
      </div>
      {order.map((t, i) => (
        <div
          key={t.item.id}
          id={`${id}-${i}`}
          role="option"
          tabIndex={-1}
          aria-selected={t.item.id === p.selectedId}
          className="sr-only"
        >
          {itemLabel(t.item)}
        </div>
      ))}
    </div>
  )
}
