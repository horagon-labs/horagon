'use client'
// A needle that swings on a spring (spec 2.4, 5.3). React writes the first angle; later angles
// go to the spring, which moves the `transform` attribute itself, so a re-render never snaps it.
// The overshoot grows with the size of the move (A2, R8: clutch.ts springBounce), and the
// Buzzer stop cuts the spring (`cut`).
import { useMotionValueEvent, useSpring } from 'motion/react'
import { type ReactNode, useEffect, useRef } from 'react'
import { springBounce } from '../../lib/chrono/clutch'
import { useMotionReduced } from '../../lib/chrono/feel'
import { SWEEP } from '../../lib/chrono/geometry'
import { justReturned } from '../../lib/chrono/now'

/** Settles in about 600 ms, with an overshoot from 0.15 (a small move) to 0.30 (a big one). */
const SETTLE_SECS = 0.6

export const rotateAbout = (angle: number, center = 100): string =>
  `rotate(${Math.round(angle * 100) / 100} ${center} ${center})`

export function Needle(props: {
  angle: number
  kind: 'price' | 'ghost'
  center?: number
  className?: string
  /** The Buzzer stop: the needle stands where it is, no swing left. */
  cut?: boolean
  children: ReactNode
}) {
  const { angle, center = 100 } = props
  const ref = useRef<SVGGElement>(null)
  const first = useRef(angle)
  const reduced = useMotionReduced()
  // The overshoot of the latest move, kept until the next one, so a re-render with the same
  // angle never changes the spring (the sweep is the whole price, 0..1).
  const move = useRef({ angle, bounce: springBounce(0) })
  if (angle !== move.current.angle) {
    move.current = { angle, bounce: springBounce((angle - move.current.angle) / SWEEP) }
  }
  const spring = useSpring(angle, {
    visualDuration: SETTLE_SECS,
    bounce: Math.round(move.current.bounce * 1000) / 1000,
  })
  useMotionValueEvent(spring, 'change', (a) =>
    ref.current?.setAttribute('transform', rotateAbout(a, center)),
  )
  const cut = props.cut === true
  useEffect(() => {
    // Reduced motion, the Buzzer stop, or back after more than 10 s away: straight there.
    if (reduced || cut || justReturned()) spring.jump(angle)
    else spring.set(angle)
  }, [angle, reduced, spring, cut])
  return (
    <g
      ref={ref}
      transform={rotateAbout(first.current, center)}
      className={props.className}
      data-needle={props.kind}
    >
      {props.children}
    </g>
  )
}
