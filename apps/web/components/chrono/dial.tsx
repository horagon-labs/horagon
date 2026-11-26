'use client'
// The dial (spec 3.2, 4.3): price needle, model mark, time ring and state on one face. It only
// draws; every decision about what to show arrives in props.
import * as m from 'motion/react-m'
import { useEffect, useId, useRef, useState } from 'react'
import { liveNumber } from '../../lib/chrono/copy'
import { useMotionReduced } from '../../lib/chrono/feel'
import { arcPath, polar, priceToAngle } from '../../lib/chrono/geometry'
import type { DialState } from '../../lib/chrono/state'
import {
  beatArmed,
  isBeat,
  needleClass,
  priceDigits,
  RING,
  rimClass,
  ringDash,
  ringShare,
} from './dial-look'
import { Needle } from './needle'
import { RollingNumber } from './rolling-number'

const C = 100
const TICKS = Array.from({ length: 11 }, (_, i) => i / 10)
/**
 * The scale's numerals: 50 inside the top tick; 0 and 100 just past the ends of the scale, below
 * the words under the hub and outside the needle's sweep, so neither ever sits under the needle
 * or the caption (merge verify, finding 5).
 */
const NUMERALS = [
  { text: '0', at: polar(C, C, 74, -150) },
  { text: '50', at: polar(C, C, 67, 0) },
  { text: '100', at: polar(C, C, 74, 150) },
]
/** Behind the caption and the detail: a needle at a low or high price passes under the words. */
const BACKDROP = 'rounded-sm bg-enamel-900/90 px-1 leading-tight'

export interface DialProps {
  /** The home side's price (YES), or null for no needle. */
  price: number | null
  modelProb: number | null
  /** Trading time left, 0..1 (timeLeftFraction). */
  timeLeft: number
  state: DialState
  /** Where the price would move after the quoted trade (spec 5.5). */
  ghostPrice?: number | null
  /** A newer quote is on its way: the ghost dims (spec 5.5). */
  ghostPending?: boolean
  /** SLIPPAGE_EXCEEDED: the ghost shakes (spec 6.1). */
  ghostShake?: boolean
  /** The full spoken sentence (spec 2.6). */
  label: string
  /**
   * What the number means (R5, lib/chrono/copy.ts): "CLE to win", "Final · CLE lost · result
   * pending", "Resolved: MEM won". None on a face with no game (loading, not found).
   */
  caption?: string
  detail?: string
  liveDot?: boolean
  /**
   * First load: the frame at full size with no needle and no number (R5), so the face never
   * reads as a price of 50 before the data is in.
   */
  loading?: boolean
  /** Polls failing: a thin red line on the bezel (spec 4.4). */
  stale?: boolean
  /**
   * Changes when a new scoring run shows up: the rim flashes amber once (spec 2.4). `undefined`
   * means not known yet (history still loading): the first key that follows is absorbed.
   */
  runKey?: string | null
  className?: string
}

/** Counts beats (see `isBeat`): `armed` is false while the dial is loading. */
function useBeat(key: string | null | undefined, armed: boolean): number {
  const prev = useRef({ key, armed })
  const [count, setCount] = useState(0)
  useEffect(() => {
    const beat = isBeat(prev.current, key)
    prev.current = { key, armed }
    if (beat) setCount((n) => n + 1)
  }, [key, armed])
  return count
}

function pts(...points: { x: number; y: number }[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(' ')
}

export function Dial(p: DialProps) {
  const id = useId()
  const reduced = useMotionReduced()
  const flash = useBeat(p.runKey, beatArmed(p.loading, p.runKey))
  const settle = useBeat(p.state === 'resolved' ? 'resolved' : null, !p.loading)
  const price = p.state === 'void' ? null : p.price
  const ghost = p.loading ? null : (p.ghostPrice ?? null)
  const blink = p.state === 'closing' ? 'animate-blink' : ''
  // The number is a chance while the market trades; once it stops, it greys like the needle.
  const tone = liveNumber(p.state) ? 'text-ivory-100' : 'text-ash-400'
  const shown = !p.loading && price !== null && Number.isFinite(price)
  return (
    <div
      role="img"
      aria-label={p.label}
      data-state={p.state}
      className={`dial dial-${p.state} relative aspect-square w-full ${p.className ?? ''}`}
    >
      <svg viewBox="0 0 200 200" aria-hidden="true" className="absolute inset-0 size-full">
        <defs>
          <radialGradient id={`${id}-face`} cx="50%" cy="42%" r="60%">
            <stop offset="0%" stopColor="#151a20" />
            <stop offset="100%" stopColor="#07090b" />
          </radialGradient>
        </defs>
        <circle
          cx={C}
          cy={C}
          r={97}
          fill={`url(#${id}-face)`}
          strokeWidth={p.state === 'challenged' ? 2 : 1}
          className={rimClass(p.state)}
          data-rim
        />
        <circle cx={C} cy={C} r={93} fill="none" strokeWidth={0.75} className="stroke-brass-700" />
        {p.stale && (
          <path
            d={arcPath(C, C, 95, -40, 40)}
            fill="none"
            strokeWidth={1.5}
            className="stroke-red-400"
            data-stale
          />
        )}
        <circle cx={C} cy={C} r={89} fill="none" strokeWidth={3} className="stroke-line" />
        <path
          d={arcPath(C, C, 89, 0, 360 * ringShare(p.state, p.timeLeft))}
          fill="none"
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={ringDash(p.state)}
          className={RING[p.state]}
          data-ring
        />
        <g className={`stroke-ash-400 ${blink}`}>
          {TICKS.map((t) => {
            const a = priceToAngle(t)
            const major = t === 0 || t === 0.5 || t === 1
            const outer = polar(C, C, 84, a)
            const inner = polar(C, C, major ? 76 : 80, a)
            return (
              <line
                key={t}
                x1={outer.x}
                y1={outer.y}
                x2={inner.x}
                y2={inner.y}
                strokeWidth={major ? 1.5 : 1}
              />
            )
          })}
        </g>
        {NUMERALS.map((n) => (
          <text
            key={n.text}
            x={n.at.x}
            y={n.at.y}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-ash-400 font-mono text-[9px]"
          >
            {n.text}
          </text>
        ))}
        {p.modelProb !== null && (
          <polygon
            points={pts(
              polar(C, C, 88, priceToAngle(p.modelProb) - 3),
              polar(C, C, 88, priceToAngle(p.modelProb) + 3),
              polar(C, C, 81, priceToAngle(p.modelProb)),
            )}
            className="fill-brass-500"
            data-model={Math.round(p.modelProb * 100)}
          />
        )}
        {ghost !== null && price !== null && (
          <path
            d={arcPath(
              C,
              C,
              74,
              Math.min(priceToAngle(price), priceToAngle(ghost)),
              Math.max(priceToAngle(price), priceToAngle(ghost)),
            )}
            fill="none"
            strokeWidth={4}
            className="stroke-amber-400/70"
            data-impact
          />
        )}
        {ghost !== null && price !== null && (
          <Needle
            angle={priceToAngle(ghost)}
            kind="ghost"
            className={`stroke-lume-300 ${p.ghostPending ? 'opacity-30' : 'opacity-70'} ${
              p.ghostShake ? 'animate-shake' : ''
            }`}
          >
            <line x1={C} y1={C} x2={C} y2={C - 70} strokeWidth={1.5} strokeDasharray="4 3" />
          </Needle>
        )}
        {!p.loading && price !== null && (
          <Needle
            angle={priceToAngle(price)}
            kind="price"
            className={`${needleClass(p.state)} ${p.state === 'proposed' ? 'opacity-40' : ''}`}
          >
            <line x1={C} y1={C + 12} x2={C} y2={C - 72} strokeWidth={2.5} strokeLinecap="round" />
          </Needle>
        )}
        <circle cx={C} cy={C} r={5} className="fill-brass-500" />
        {!reduced && flash > 0 && (
          <m.circle
            key={`run-${flash}`}
            cx={C}
            cy={C}
            r={96}
            fill="none"
            strokeWidth={3}
            className="stroke-amber-400"
            initial={{ opacity: 1 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 0.9 }}
            data-beat="run"
          />
        )}
        {!reduced && settle > 0 && p.state === 'resolved' && (
          <m.circle
            key={`settle-${settle}`}
            cx={C}
            cy={C}
            r={12}
            className="fill-lume-300"
            initial={{ opacity: 0.8, scale: 1.8 }}
            animate={{ opacity: 0, scale: 1 }}
            transition={{ duration: 0.6 }}
            data-beat="settle"
          />
        )}
      </svg>
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-[54%] flex flex-col items-center gap-0.5 text-center"
      >
        {p.loading ? (
          <span className="block h-10 w-20 rounded-card bg-line/60" data-skeleton />
        ) : (
          // Resolved: the caption says who won; a locked 100 or 0 beside it would read as the
          // home side's number next to an away win.
          p.state !== 'resolved' && (
            <span className={`flex items-baseline font-mono tabular-nums ${tone}`}>
              <RollingNumber text={priceDigits(price)} className="font-mono text-40 tabular-nums" />
              {shown && <span className="text-19">%</span>}
            </span>
          )
        )}
        {p.caption && (
          <span
            className={`flex max-w-[70%] items-center justify-center gap-1.5 text-12 uppercase tracking-[0.16em] text-brass-500 ${BACKDROP}`}
            data-caption
          >
            {p.liveDot && <span className="size-1.5 shrink-0 rounded-full bg-lume-300" data-live />}
            {p.caption}
          </span>
        )}
        {p.detail && (
          <span className={`max-w-[70%] font-mono text-12 text-ash-400 ${BACKDROP}`}>
            {p.detail}
          </span>
        )}
      </div>
    </div>
  )
}
