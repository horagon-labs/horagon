// The 404 page (culture plan A3, string 24; light branding review §4.12): the mark's white face in
// its brass case, its needle fallen past the end of the scale into a slot at 6 o'clock, then the
// way back to the board. Inside the root layout, so the header and the play-money banner are there
// too and Next's own page (which turns black on a dark OS) never shows. Static: no client code.
import Link from 'next/link'
import { arcPath, MAX_ANGLE, MIN_ANGLE, polar } from '../lib/chrono/geometry'

const C = 100
/** The scale's ticks, every 27° from one end to the other (0% to 100%). */
const TICKS = Array.from({ length: 11 }, (_, i) => MIN_ANGLE + i * 27)

export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-4 py-12 text-center">
      <svg viewBox="0 0 200 200" aria-hidden="true" className="size-36" data-mark>
        {/* The stopped mark (review §4.10): a white face in a brass case, nothing live on it. */}
        <circle cx={C} cy={C} r={95} strokeWidth={5} className="fill-surface-raised stroke-brass" />
        <path
          d={arcPath(C, C, 80, MIN_ANGLE, MAX_ANGLE)}
          fill="none"
          strokeWidth={2}
          className="stroke-rule-faint"
        />
        {TICKS.map((a) => {
          const from = polar(C, C, 74, a)
          const to = polar(C, C, 84, a)
          return (
            <line
              key={a}
              x1={from.x}
              y1={from.y}
              x2={to.x}
              y2={to.y}
              strokeWidth={2}
              className="stroke-ink-muted"
            />
          )
        })}
        {/* The slot below the scale's open end, sunk into the face, where the needle came to rest. */}
        <rect
          x={C - 8}
          y={168}
          width={16}
          height={20}
          rx={3}
          strokeWidth={1.5}
          className="fill-surface-sunk stroke-rule"
          data-slot
        />
        <line
          x1={C}
          y1={C}
          x2={C}
          y2={182}
          strokeWidth={5}
          strokeLinecap="round"
          className="stroke-ink-muted"
          data-needle
        />
        <circle cx={C} cy={C} r={9} className="fill-ink" />
      </svg>
      <h1 className="text-19 font-semibold">Air ball. Nothing on the clock at this address.</h1>
      <Link
        href="/"
        className="inline-flex min-h-11 items-center text-15 underline underline-offset-4"
      >
        Back to tonight's games
      </Link>
    </div>
  )
}
