'use client'
// The 48 px dial for list rows (spec 3.2): needle and time ring only, no number and no ghost.
// The row around it carries the words, so the picture stays hidden from screen readers. Your
// position is the row's ◆, never the rim (light branding review §4.3). Before a market exists an
// ink ▲ on the rim marks the model's chance (first-screen spec W4), like the big dial's model mark.
// Before it opens (`pre`, no price) the ring carries that chance instead of a full time ring: a
// dashed ink arc along the price scale from 0 to the ▲, dashed like the story tape's model line,
// so each row's dial has its own shape and none reads as an empty clock (fresh-eyes note 4).
import { arcPath, MIN_ANGLE, polar, priceToAngle } from '../../lib/chrono/geometry'
import type { DialState } from '../../lib/chrono/state'
import { needleClass, rimClass, rimWidth, ringClass, ringDash, ringShare } from './dial-look'
import { Needle } from './needle'

export function MiniDial(p: {
  price: number | null
  /** The model's home chance, drawn as a ▲ only while there is no price (no market yet). */
  model?: number | null
  timeLeft: number
  state: DialState
  className?: string
}) {
  // Not open yet: the model's chance on the ring, in place of the time ring. A game that started
  // with no market has no time left (timeLeft 0) and will not open, so it keeps the ▲ alone.
  const gauge =
    p.price === null && p.model != null && p.state === 'pre' && p.timeLeft > 0 ? p.model : null
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
        strokeWidth={rimWidth(p.state)}
        className={`fill-enamel-900 ${rimClass(p.state)}`}
        data-rim
      />
      <circle cx={50} cy={50} r={42} fill="none" strokeWidth={4} className="stroke-rule-faint" />
      {gauge !== null ? (
        <path
          d={arcPath(50, 50, 42, MIN_ANGLE, priceToAngle(gauge))}
          fill="none"
          strokeWidth={4}
          strokeDasharray="7 4"
          className="stroke-ink"
          data-model-arc
        />
      ) : (
        <path
          d={arcPath(50, 50, 42, 0, 360 * ringShare(p.state, p.timeLeft))}
          fill="none"
          // Closing: wider (6 against 4), the same live hue (review §4.3).
          strokeWidth={p.state === 'closing' ? 6 : 4}
          strokeDasharray={ringDash(p.state)}
          className={ringClass(p.state, p.price !== null)}
          data-ring
        />
      )}
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
      {p.price === null && p.model != null && <ModelMark model={p.model} />}
      <circle cx={50} cy={50} r={4} className="fill-brass-500" />
      <circle cx={50} cy={50} r={1.3} className="fill-enamel-900" />
    </svg>
  )
}

/** An ink ▲ on the rim at the model's chance, its point toward the centre. */
function ModelMark({ model }: { model: number }) {
  const a = priceToAngle(model)
  const [l, r, tip] = [polar(50, 50, 49, a - 9), polar(50, 50, 49, a + 9), polar(50, 50, 36, a)]
  return (
    <path d={`M${l.x} ${l.y}L${r.x} ${r.y}L${tip.x} ${tip.y}Z`} className="fill-ink" data-model />
  )
}
