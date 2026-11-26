'use client'
// The Night dial (spec 3.2, 4.1): tonight on one 12-hour ET face, one arc per game on the ring
// tracks.ts picks. The picture is hidden; a listbox of sr-only options carries the same games.
// On a night with no game it rests (culture plan A3): numerals, a lume pip on the now hand and
// a seconds pip that steps once a second, with the next tip-off in the middle.
import { type KeyboardEvent, type MouseEvent, useId, useState } from 'react'
import { type BoardItem, itemLabel, rowWords } from '../../lib/chrono/board'
import { useMotionReduced } from '../../lib/chrono/feel'
import { arcPath, etClockAngle, polar } from '../../lib/chrono/geometry'
import { keyStep } from '../../lib/chrono/keys'
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
const HAND = 92
/** The rest face's numerals: 12 · 3 · 6 · 9 at r 80. */
const NUMERALS = [12, 3, 6, 9].map((n) => ({ n, at: polar(C, C, 80, (n % 12) * 30) }))

/**
 * The rest face's marks (culture plan A3): the numerals in mono 9 brass with "ET" under the 6,
 * and a seconds pip at r 97 that steps 6° a second from the shared clock: no tween, and none
 * under reduced motion. The lume pip rides on the now hand (NightDial).
 */
export function RestFace(p: { now: number; reduced: boolean }) {
  const sec = polar(C, C, 97, (Math.floor(p.now) % 60) * 6)
  const six = NUMERALS[2]?.at ?? { x: C, y: 180 }
  return (
    <g data-rest>
      {NUMERALS.map(({ n, at }) => (
        <text
          key={n}
          x={at.x}
          y={at.y}
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-brass-500 font-mono text-[9px]"
        >
          {n}
        </text>
      ))}
      <text
        x={six.x}
        y={six.y + 7}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-brass-500 font-mono text-[5px]"
      >
        ET
      </text>
      {!p.reduced && (
        <circle cx={sec.x} cy={sec.y} r={1.8} className="fill-ivory-100" data-seconds />
      )}
    </g>
  )
}

/**
 * Your games glow lume; amber near the close; brass while open; ash once trading stopped, and for
 * a game that started with no market (`trading`, R5c refix).
 */
function arcClass(item: BoardItem, lit: boolean): string {
  if (item.held) return 'stroke-lume-300'
  if (item.state === 'closing' || item.state === 'halted') return 'stroke-amber-400'
  if (item.trading) return lit ? 'stroke-brass-400' : 'stroke-brass-500'
  return 'stroke-ash-400'
}

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
  /** No game tonight: the rest face, with `emptyText` (the next tip-off) in the middle. */
  rest?: boolean
  className?: string
}) {
  const id = useId()
  const reduced = useMotionReduced()
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
  const hand = polar(C, C, HAND, angle)
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
        <circle cx={C} cy={C} r={97} strokeWidth={1} className="fill-enamel-800 stroke-line" />
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
                  strokeWidth={lit ? 5 : 3.5}
                  strokeDasharray={s.pre ? '2 2.5' : undefined}
                  className={[arcClass(t.item, lit), s.past && 'opacity-35']
                    .filter(Boolean)
                    .join(' ')}
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
        {spots.map((s) => (
          <text
            key={s.id}
            x={s.x}
            y={s.y}
            textAnchor={s.anchor}
            dominantBaseline="middle"
            className="fill-ivory-100 font-mono text-[8px]"
          >
            {tracks.find((t) => t.item.id === s.id)?.item.game.home}
          </text>
        ))}
        <circle
          cx={C}
          cy={C}
          r={HUB}
          fill="none"
          strokeWidth={0.75}
          className="stroke-line"
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
        {p.rest && (
          <>
            <RestFace now={p.now} reduced={reduced} />
            <circle cx={hand.x} cy={hand.y} r={2} className="fill-lume-300" data-now-pip />
          </>
        )}
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
        {/* At rest no arc rings the face, so the words may run wider, inside the numerals. */}
        <div
          className={`flex ${p.rest ? 'max-w-[56%]' : 'max-w-[32%]'} flex-col items-center gap-0.5 text-center`}
        >
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
