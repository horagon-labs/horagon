'use client'
// A needle that swings on a spring (spec 2.4, 5.3). React writes the first angle; later angles
// go to the spring, which moves the `transform` attribute itself, so a re-render never snaps it.
import { useMotionValueEvent, useSpring } from 'motion/react'
import { type ReactNode, useEffect, useRef } from 'react'
import { useMotionReduced } from '../../lib/chrono/feel'
import { justReturned } from '../../lib/chrono/now'

/** Settles in about 600 ms with a small overshoot. */
const SPRING = { visualDuration: 0.6, bounce: 0.15 }

export const rotateAbout = (angle: number, center = 100): string =>
  `rotate(${Math.round(angle * 100) / 100} ${center} ${center})`

export function Needle(props: {
  angle: number
  kind: 'price' | 'ghost'
  center?: number
  className?: string
  children: ReactNode
}) {
  const { angle, center = 100 } = props
  const ref = useRef<SVGGElement>(null)
  const first = useRef(angle)
  const reduced = useMotionReduced()
  const spring = useSpring(angle, SPRING)
  useMotionValueEvent(spring, 'change', (a) =>
    ref.current?.setAttribute('transform', rotateAbout(a, center)),
  )
  useEffect(() => {
    // Reduced motion, or back after more than 10 s away: straight to the new price.
    if (reduced || justReturned()) spring.jump(angle)
    else spring.set(angle)
  }, [angle, reduced, spring])
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
