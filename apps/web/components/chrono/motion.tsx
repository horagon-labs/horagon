'use client'
// Motion for the whole app (spec 2.4): LazyMotion with the small DOM bundle keeps `m` cheap, and
// the feel switch decides reduced motion for motion and, through html[data-motion], for CSS.
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react'
import { type ReactNode, useEffect } from 'react'
import { useFeel } from '../../lib/chrono/feel'

const MODE = { system: 'user', reduced: 'always', full: 'never' } as const

export function ChronoMotion({ children }: { children: ReactNode }) {
  const [feel] = useFeel()
  const choice = feel.reducedMotion === null ? 'system' : feel.reducedMotion ? 'reduced' : 'full'
  useEffect(() => {
    const root = document.documentElement
    if (choice === 'system') root.removeAttribute('data-motion')
    else root.setAttribute('data-motion', choice)
  }, [choice])
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion={MODE[choice]}>{children}</MotionConfig>
    </LazyMotion>
  )
}
