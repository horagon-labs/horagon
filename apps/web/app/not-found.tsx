// The 404 page (culture plan A3, string 24): an ash dial whose needle fell past the end of the
// scale into a slot at 6 o'clock, then the way back to the board. Static: no client code.
import Link from 'next/link'
import { arcPath, MAX_ANGLE, MIN_ANGLE, polar } from '../lib/chrono/geometry'

const C = 100
/** The scale's ticks, every 27° from one end to the other (0% to 100%). */
const TICKS = Array.from({ length: 11 }, (_, i) => MIN_ANGLE + i * 27)

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md space-y-4 py-8 text-center">
      <svg viewBox="0 0 200 200" aria-hidden="true" className="mx-auto w-full max-w-60">
        <circle cx={C} cy={C} r={97} strokeWidth={1} className="fill-enamel-800 stroke-line" />
        <path
          d={arcPath(C, C, 84, MIN_ANGLE, MAX_ANGLE)}
          fill="none"
          strokeWidth={2}
          className="stroke-line"
        />
        {TICKS.map((a) => {
          const from = polar(C, C, 78, a)
          const to = polar(C, C, 88, a)
          return (
            <line
              key={a}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              strokeWidth={1}
              className="stroke-ash-400"
            />
          )
        })}
        {/* The slot below the scale's open end, where the needle came to rest. */}
        <rect
          x={C - 7}
          y={176}
          width={14}
          height={18}
          rx={3}
          className="fill-enamel-950"
          data-slot
        />
        <line
          x1={C}
          y1={C}
          x2={C}
          y2={188}
          strokeWidth={3}
          strokeLinecap="round"
          className="stroke-ash-400"
          data-needle
        />
        <circle cx={C} cy={C} r={4} className="fill-ash-400" />
      </svg>
      <h1 className="text-19 font-medium text-ivory-100">
        Air ball. Nothing on the clock at this address.
      </h1>
      <Link
        href="/"
        className="inline-flex min-h-11 items-center text-15 text-lume-300 underline-offset-4 hover:underline"
      >
        Back to tonight's games
      </Link>
    </div>
  )
}
