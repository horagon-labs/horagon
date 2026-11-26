'use client'
// The dial (spec 3.2, 4.3): price needle, model mark, time ring and state on one face. It only
// draws; every decision about what to show arrives in props.
import * as m from 'motion/react-m'
import { useEffect, useRef, useState } from 'react'
import { liveNumber } from '../../lib/chrono/copy'
import { useMotionReduced } from '../../lib/chrono/feel'
import { arcPath, polar, priceToAngle } from '../../lib/chrono/geometry'
import type { DialState } from '../../lib/chrono/state'
import {
  beatArmed,
  isBeat,
  needleClass,
  priceDigits,
  rimClass,
  rimWidth,
  ringClass,
  ringDash,
  ringShare,
  STALE_ARC,
  STALE_CASE,
} from './dial-look'
import { Needle } from './needle'
import { RollingNumber } from './rolling-number'

const C = 100
const TICKS = Array.from({ length: 11 }, (_, i) => i / 10)
/**
 * The scale's numbers, [price, radius, angle]: 0 and 100 sit at r70, 142° out, below the ends of
 * the scale and clear of the caption; 50 at r69 (light branding review §4.2).
 */
const NUMBERS = [
  [0, 70, -142],
  [0.5, 69, 0],
  [1, 70, 142],
] as const

export interface DialProps {
  /** The home side's price (YES), or null for no needle. */
  price: number | null
  modelProb: number | null
  /** Trading time left, 0..1 (timeLeftFraction). */
  timeLeft: number
  state: DialState
  /** Where the price would move after the quoted trade (spec 5.5). */
  ghostPrice?: number | null
  /** A newer quote is on its way: the ghost turns to the plain rule (spec 5.5, review §3.4). */
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
  const reduced = useMotionReduced()
  const flash = useBeat(p.runKey, beatArmed(p.loading, p.runKey))
  const settle = useBeat(p.state === 'resolved' ? 'resolved' : null, !p.loading)
  const price = p.state === 'void' ? null : p.price
  const ghost = p.loading ? null : (p.ghostPrice ?? null)
  const blink = p.state === 'closing' ? 'animate-blink' : ''
  // The number is a chance while the market trades; once it stops, it greys like the needle.
  const tone = liveNumber(p.state) ? 'text-ivory-100' : 'text-ash-400'
  const shown = !p.loading && price !== null && Number.isFinite(price)
  // Under review the red rim already replaces the whole case.
  const cutCase = p.stale && p.state !== 'challenged'
  return (
    <div
      role="img"
      aria-label={p.label}
      data-state={p.state}
      // A container, so the caption can read the face's own width (review §8 risk 3).
      className={`dial dial-${p.state} @container relative aspect-square w-full ${p.className ?? ''}`}
    >
      <svg viewBox="0 0 200 200" aria-hidden="true" className="absolute inset-0 size-full">
        {/* A flat white sheet: no gradient, no shadow (spec 2.3, light branding review §4.2). */}
        <circle cx={C} cy={C} r={97} className="fill-enamel-900" />
        {cutCase ? (
          // Stale: the case stops 6° short of the red arc that takes its place (review §3.5).
          <path
            d={arcPath(C, C, 97, ...STALE_CASE)}
            fill="none"
            strokeWidth={rimWidth(p.state)}
            className={rimClass(p.state)}
            data-rim
          />
        ) : (
          <circle
            cx={C}
            cy={C}
            r={97}
            fill="none"
            strokeWidth={rimWidth(p.state)}
            className={rimClass(p.state)}
            data-rim
          />
        )}
        <circle cx={C} cy={C} r={93} fill="none" strokeWidth={0.75} className="stroke-rule-faint" />
        {p.stale && (
          <path
            d={arcPath(C, C, 97, ...STALE_ARC)}
            fill="none"
            strokeWidth={2}
            className="stroke-red-400"
            data-stale
          />
        )}
        <circle cx={C} cy={C} r={89} fill="none" strokeWidth={3} className="stroke-rule-faint" />
        {/* The loading frame has no time ring: a full muted one would read "no market yet". */}
        {!p.loading && (
          <path
            d={arcPath(C, C, 89, 0, 360 * ringShare(p.state, p.timeLeft))}
            fill="none"
            // Closing shares live's hue: it is told apart by width, the blinking ticks and
            // "closes in" (review §3.5).
            strokeWidth={p.state === 'closing' ? 4.5 : 3}
            // A dashed ring gets butt caps: round ones would fill the hatch's and the dots' gaps.
            strokeLinecap={ringDash(p.state) ? 'butt' : 'round'}
            strokeDasharray={ringDash(p.state)}
            className={ringClass(p.state, price !== null)}
            data-ring
          />
        )}
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
        {p.modelProb !== null && p.state !== 'void' && (
          <polygon
            // Base at r86, 1.5 inside the ring's inner edge (87.5), tip at r78.5 (review §4.2).
            points={pts(
              polar(C, C, 86, priceToAngle(p.modelProb) - 3.8),
              polar(C, C, 86, priceToAngle(p.modelProb) + 3.8),
              polar(C, C, 78.5, priceToAngle(p.modelProb)),
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
            className="stroke-line"
            data-impact
          />
        )}
        {ghost !== null && price !== null && (
          <Needle
            angle={priceToAngle(ghost)}
            kind="ghost"
            // Priced: live and whole; a newer quote on its way: the plain rule (review §3.4).
            className={[
              p.ghostPending ? 'stroke-line' : 'stroke-live',
              p.ghostShake && 'animate-shake',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <line x1={C} y1={C} x2={C} y2={C - 70} strokeWidth={1.5} strokeDasharray="4 3" />
          </Needle>
        )}
        {!p.loading && price !== null && (
          <Needle angle={priceToAngle(price)} kind="price" className={needleClass(p.state)}>
            {/* A proposal dashes the needle instead of fading it (review §3.4: 7.10, not 1.90). */}
            <line
              x1={C}
              y1={C + 8}
              x2={C}
              y2={C - 72}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeDasharray={p.state === 'proposed' ? '6 4' : undefined}
            />
          </Needle>
        )}
        {/*
          After the needles, on a paper halo: a needle at 0 or 100 (every settled face) ends under
          the number instead of running across it (review v1 #4).
        */}
        {NUMBERS.map(([t, r, a]) => {
          const at = polar(C, C, r, a)
          return (
            <text
              key={t}
              x={at.x}
              y={at.y}
              textAnchor="middle"
              dominantBaseline="middle"
              strokeWidth={2.5}
              strokeLinejoin="round"
              paintOrder="stroke"
              className="fill-ash-400 stroke-surface-raised font-mono text-[9px]"
            >
              {t * 100}
            </text>
          )
        })}
        {/* The ink hub with a paper pin (review §4.2). */}
        <circle cx={C} cy={C} r={5} className="fill-brass-500" />
        <circle cx={C} cy={C} r={1.6} className="fill-enamel-900" />
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
            fill="none"
            strokeWidth={1.5}
            className="stroke-ivory-100"
            // An ink ring closing on the hub, r12 to r5 (review §4.2).
            initial={{ r: 12, opacity: 1 }}
            animate={{ r: 5, opacity: 0 }}
            transition={{ duration: 0.6 }}
            data-beat="settle"
          />
        )}
      </svg>
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-[54%] flex flex-col items-center gap-1 text-center @max-[21rem]:top-[53%] @max-[21rem]:gap-0.5"
      >
        {p.loading ? (
          <span className="block h-10 w-20 rounded-card bg-enamel-800" data-skeleton />
        ) : (
          // Resolved: the caption says who won; a locked 100 or 0 beside it would read as the
          // home side's number next to an away win.
          p.state !== 'resolved' && (
            // On paper, like the caption: a needle past 83 or under 17 runs below the hub.
            <span
              className={`flex items-baseline bg-surface-raised font-mono tabular-nums ${tone}`}
            >
              <RollingNumber
                text={priceDigits(price)}
                // 36 on a face under 336 px, so the caption below stays above 0 and 100.
                className="font-mono text-40 tabular-nums @max-[21rem]:text-[2.25rem]"
              />
              {shown && <span className="text-19">%</span>}
            </span>
          )
        )}
        {p.caption && (
          // One line, clear of 0 and 100 (review §4.2, §8 risk 3): the longest caption, "Final ·
          // CLE lost · result pending", fits 80 % of a face from 336 px; a narrower face (a 320 px
          // phone, the crown) drops the tracking, a size of number and a little height instead of
          // wrapping onto the scale's numbers.
          <span
            className="flex max-w-[80%] items-center justify-center gap-1.5 bg-surface-raised text-12 uppercase tracking-[0.16em] text-brass-500 @max-[21rem]:tracking-normal"
            data-caption
          >
            {p.liveDot && <span className="size-1.5 shrink-0 rounded-full bg-lume-300" data-live />}
            {p.caption}
          </span>
        )}
        {p.detail && (
          <span className="bg-surface-raised font-mono text-12 text-ash-400">{p.detail}</span>
        )}
      </div>
    </div>
  )
}
