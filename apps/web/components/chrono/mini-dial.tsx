'use client'
// The 48 px dial for list rows (spec 3.2): needle and time ring only, no number and no ghost.
// The row around it carries the words, so the picture stays hidden from screen readers. Your
// position is the row's ◆, never the rim (light branding review §4.3).
import { arcPath, priceToAngle } from '../../lib/chrono/geometry'
import type { DialState } from '../../lib/chrono/state'
import { needleClass, rimClass, ringClass, ringDash, ringShare } from './dial-look'
import { Needle } from './needle'

export function MiniDial(p: {
  price: number | null
  timeLeft: number
  state: DialState
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden="true"
      data-state={p.state}
      className={`dial-mini dial-${p.state} size-12 shrink-0 ${p.className ?? ''}`}
    >
      <circle
        cx={50}
        cy={50}
        r={48}
        strokeWidth={1}
        className={`fill-enamel-800 ${rimClass(p.state)}`}
        data-rim
      />
      <circle cx={50} cy={50} r={42} fill="none" strokeWidth={4} className="stroke-line" />
      <path
        d={arcPath(50, 50, 42, 0, 360 * ringShare(p.state, p.timeLeft))}
        fill="none"
        strokeWidth={4}
        strokeDasharray={ringDash(p.state)}
        className={ringClass(p.state, p.price !== null)}
        data-ring
      />
      {p.price !== null && p.state !== 'void' && (
        <Needle
          angle={priceToAngle(p.price)}
          center={50}
          kind="price"
          className={needleClass(p.state)}
        >
          <line x1={50} y1={56} x2={50} y2={16} strokeWidth={3} strokeLinecap="round" />
        </Needle>
      )}
      <circle cx={50} cy={50} r={4} className="fill-brass-500" />
    </svg>
  )
}
