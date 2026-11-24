'use client'
// The bezel (spec 3.2, 2.6): a slider ring around the dial. Drag the ring, scroll one step per
// notch, or use a slider's keys; the crown at 3 o'clock is where a thumb starts. Each new step
// buzzes 5 ms and ticks when those are on (spec 2.5).
import { type PointerEvent, type ReactNode, useRef } from 'react'
import {
  angleToStep,
  dragAngle,
  pointerAngle,
  type Step,
  stepAngle,
  stepCrossed,
  wheelStep,
} from '../../lib/chrono/bezel'
import { buzz, playTick, STEP_BUZZ_MS, useFeel } from '../../lib/chrono/feel'
import { arcPath, MIN_ANGLE, polar } from '../../lib/chrono/geometry'
import { keyStep } from '../../lib/chrono/keys'

const C = 100

export function Bezel(p: {
  steps: readonly Step[]
  index: number
  onChange: (index: number) => void
  label: string
  children: ReactNode
  className?: string
}) {
  const [feel] = useFeel()
  const n = p.steps.length
  const index = Math.min(p.index, Math.max(0, n - 1))
  const current = p.steps[index]
  const first = p.steps[0]
  const last = p.steps[n - 1]
  // The drag's own angle: unwrapped against the last one, so it never jumps across the gap.
  const angle = useRef(stepAngle(index, n))
  const dragging = useRef(false)

  function go(next: number) {
    if (n === 0 || !stepCrossed(index, next)) return
    buzz(feel, STEP_BUZZ_MS)
    playTick(feel)
    p.onChange(next)
  }

  function follow(e: PointerEvent<HTMLDivElement>) {
    const box = e.currentTarget.getBoundingClientRect()
    const raw = pointerAngle(
      e.clientX,
      e.clientY,
      box.left + box.width / 2,
      box.top + box.height / 2,
    )
    angle.current = dragAngle(angle.current, raw)
    go(angleToStep(angle.current, n))
  }

  const crown = polar(C, C, 97, 90)
  return (
    // The dial sits beside the slider, not inside it: a slider's children are presentational,
    // so a dial inside would hide its label from screen readers (spec 2.6). Pointers pass
    // through the dial to the ring.
    <div className={`relative aspect-square w-full ${p.className ?? ''}`}>
      <div
        role="slider"
        tabIndex={0}
        aria-label={p.label}
        aria-valuemin={first ? Number(first.amount) : 0}
        aria-valuemax={last ? Number(last.amount) : 0}
        aria-valuenow={current ? Number(current.amount) : 0}
        aria-valuetext={current?.text ?? 'No amount'}
        aria-disabled={n === 0 ? true : undefined}
        onKeyDown={(e) => {
          const next = keyStep(e.key, index, n, 'slider')
          if (next === null) return
          e.preventDefault()
          go(next)
        }}
        onPointerDown={(e) => {
          if (n === 0) return
          dragging.current = true
          angle.current = stepAngle(index, n)
          e.currentTarget.setPointerCapture(e.pointerId)
          follow(e)
        }}
        onPointerMove={(e) => {
          if (dragging.current) follow(e)
        }}
        onPointerUp={(e) => {
          dragging.current = false
          e.currentTarget.releasePointerCapture(e.pointerId)
        }}
        onWheel={(e) => {
          const d = wheelStep(e.deltaY)
          if (d !== 0) go(Math.min(n - 1, Math.max(0, index + d)))
        }}
        className="absolute inset-0 touch-none select-none rounded-full"
      >
        <svg viewBox="0 0 200 200" aria-hidden="true" className="absolute inset-0 size-full">
          <circle cx={C} cy={C} r={95} fill="none" strokeWidth={6} className="stroke-enamel-800" />
          {n > 0 && (
            <path
              d={arcPath(C, C, 95, MIN_ANGLE, stepAngle(index, n))}
              fill="none"
              strokeWidth={6}
              className="stroke-lume-300/70"
              data-bezel-arc
            />
          )}
          {p.steps.map((s, i) => {
            const a = stepAngle(i, n)
            const o = polar(C, C, 99, a)
            const inner = polar(C, C, 91, a)
            return (
              <line
                key={s.amount}
                x1={o.x}
                y1={o.y}
                x2={inner.x}
                y2={inner.y}
                strokeWidth={i === index ? 2 : 1}
                className={i === index ? 'stroke-lume-300' : 'stroke-brass-700'}
              />
            )
          })}
          <rect
            x={crown.x - 2}
            y={crown.y - 9}
            width={5}
            height={18}
            rx={1.5}
            className="fill-brass-500"
            data-crown
          />
        </svg>
      </div>
      <div className="pointer-events-none absolute inset-[7%]">{p.children}</div>
    </div>
  )
}
