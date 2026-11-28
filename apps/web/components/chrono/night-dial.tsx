'use client'
// The Night dial (spec 3.2, 4.1): tonight on one 12-hour ET face, one arc per game on the ring
// tracks.ts picks. The picture is hidden; a listbox of sr-only options carries the same games.
// On a night with no game it rests (culture plan A3): numerals, a pip on the now hand and a
// seconds pip that steps once a second, with the next tip-off in the middle. All of it is ink:
// live is an open market's colour alone (light branding review §3.2), and none is open.
import { type KeyboardEvent, type MouseEvent, useId, useState } from 'react'
import { type BoardItem, itemLabel, rowWords } from '../../lib/chrono/board'
import { useMotionReduced } from '../../lib/chrono/feel'
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
import { STALE_ARC, STALE_CASE, stateLine } from './dial-look'

const C = 100
// The readout's hub, inside ring 7 (r = 37, whose lit stroke edge is 34.5).
const HUB = 33
// At rest the words run 56% of the face wide (56 units each side), so the hand starts past
// them: from the centre it struck through them whenever the clock read near 3:00 or 9:00.
const REST_HUB = 62
const HOURS = Array.from({ length: 12 }, (_, h) => h)
const HAND = 92
/** The rest face's numerals: 12 · 3 · 6 · 9 at r 80. */
const NUMERALS = [12, 3, 6, 9].map((n) => ({ n, at: polar(C, C, 80, (n % 12) * 30) }))

/**
 * The rest face's marks (culture plan A3): the numerals in mono 9 ink with "ET" under the 6,
 * and a seconds pip at r 97 that steps 6° a second from the shared clock: no tween, and none
 * under reduced motion. The ink pip rides on the now hand (NightDial).
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
          className="fill-ink font-mono text-[9px]"
        >
          {n}
        </text>
      ))}
      <text
        x={six.x}
        y={six.y + 7}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-ink font-mono text-[5px]"
      >
        ET
      </text>
      {!p.reduced && <circle cx={sec.x} cy={sec.y} r={1.8} className="fill-ink" data-seconds />}
    </g>
  )
}

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
  /** No game tonight: the rest face, with `emptyText` (the next tip-off) in the middle. */
  rest?: boolean
  className?: string
}) {
  const id = useId()
  const reduced = useMotionReduced()
  const [active, setActive] = useState<string | null>(null)
  const { tracks } = packTracks(p.items, p.now)
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
  const focusWords = focus ? rowWords(focus, p.now) : null
  const angle = etClockAngle(p.now)
  const hand = polar(C, C, HAND, angle)
  const hub = polar(C, C, p.rest ? REST_HUB : HUB, angle)

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
      className={`@container relative aspect-square w-full rounded-full ${p.className ?? ''}`}
    >
      <svg viewBox="0 0 200 200" aria-hidden="true" className="absolute inset-0 size-full">
        {/* A white face in a brass case (light branding review §4.4). */}
        {p.stale ? (
          // Stale: the red arc takes the case's place, which stops 6° short of it (review §3.5).
          <>
            <circle cx={C} cy={C} r={97} className="fill-surface-raised" />
            <path
              d={arcPath(C, C, 97, ...STALE_CASE)}
              fill="none"
              strokeWidth={1.5}
              className="stroke-brass"
              data-case
            />
            <path
              d={arcPath(C, C, 97, ...STALE_ARC)}
              fill="none"
              strokeWidth={2}
              className="stroke-red-400"
              data-stale
            />
          </>
        ) : (
          <circle
            cx={C}
            cy={C}
            r={97}
            strokeWidth={1.5}
            className="fill-enamel-900 stroke-brass-700"
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
        {/*
          The readout's ring. At rest the words run wider than it (no arc rings the face), so it
          goes: on white a faint line through the words reads as a strike, not a frame.
        */}
        {!p.rest && (
          <circle
            cx={C}
            cy={C}
            r={HUB}
            fill="none"
            strokeWidth={0.75}
            className="stroke-rule-faint"
            data-hub
          />
        )}
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
        {/*
          The labels last, on a paper halo: the next game to close ends near the hand, so its label
          sat on live arcs (2.68:1) and under the hand; on paper it is ink on white, 17.60.
        */}
        {spots.map((s) => {
          const item = tracks.find((t) => t.item.id === s.id)?.item
          return (
            <text
              key={s.id}
              x={s.x}
              y={s.y}
              textAnchor={s.anchor}
              dominantBaseline="middle"
              strokeWidth={2.5}
              strokeLinejoin="round"
              paintOrder="stroke"
              className="fill-ivory-100 stroke-surface-raised font-mono text-[8px]"
            >
              {item?.held && <tspan className="fill-live">◆ </tspan>}
              {item?.game.home}
            </text>
          )
        })}
        {p.rest && (
          <>
            <RestFace now={p.now} reduced={reduced} />
            <circle cx={hand.x} cy={hand.y} r={2} className="fill-ink" data-now-pip />
          </>
        )}
      </svg>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center"
      >
        {/*
          At rest no arc rings the face, so the words may run wider, inside the numerals. Otherwise
          they stay inside the hub ring (r 33 of 200): the dial is a size container and the readout
          reads its own width. The 26rem dial (lg) holds the matchup, the number, whose chance and
          the state line. A smaller hub (375: a 343 px dial, a 113 px hub) has no room for the
          two-line state line, whose words the rows above it carry ("+2 since open", "closes in
          2:08"); under 20rem the matchup goes too, and the arc's label and the subject still name
          the team. The 12 px lines keep a 14 px line and the number a 28 px one, so a three-line
          state line (overtime) fits the 26rem hub.
          The games past the 8th ring are in the rows only, with no count here: "+3" under "NYK to
          win" read as a move since open (C20's "+2 since open"), and a signed number on / means
          that and nothing else.
        */}
        <div
          className={`flex ${p.rest ? 'max-w-[56%] gap-0.5' : 'max-w-[32%]'} flex-col items-center text-center`}
          data-readout-words
        >
          {focus && focusWords ? (
            <>
              <span className="hidden text-12 leading-3.5 uppercase tracking-[0.16em] text-brass-500 @min-[20rem]:block">
                {focus.game.away} @ {focus.game.home}
              </span>
              {focusWords.value && (
                <span className="font-mono text-24 leading-7 text-ivory-100 tabular-nums">
                  {focusWords.value}
                  {focusWords.model && (
                    <span className="font-sans text-12 text-ink-muted"> model</span>
                  )}
                </span>
              )}
              {focusWords.subject && (
                <span className="text-12 leading-3.5 text-brass-400">{focusWords.subject}</span>
              )}
              <span className="hidden font-mono text-12 leading-3.5 text-ash-400 @min-[26rem]:block">
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
