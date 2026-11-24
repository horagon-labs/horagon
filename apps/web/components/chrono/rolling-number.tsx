'use client'
// The price rolls digit by digit like a gauge (spec 2.4); other characters stand still.
import { m } from 'motion/react'
import { useMotionReduced } from '../../lib/chrono/feel'

const DIGITS = [...'0123456789']
const ROLL = { type: 'spring', visualDuration: 0.5, bounce: 0.1 } as const

export function RollingNumber({ text, className }: { text: string; className?: string }) {
  const reduced = useMotionReduced()
  return (
    <span data-value={text} className={`inline-flex leading-none ${className ?? ''}`}>
      {[...text].map((ch, i) => {
        const digit = DIGITS.indexOf(ch)
        // Keyed from the right, so 99 -> 100 keeps the ones column where it was.
        const key = text.length - i
        if (digit === -1) return <span key={key}>{ch}</span>
        return (
          <span key={key} className="relative inline-block h-[1em] w-[0.62em] overflow-hidden">
            <m.span
              className="absolute inset-x-0 top-0 flex flex-col"
              initial={false}
              animate={{ y: `${-digit * 10}%` }}
              transition={reduced ? { duration: 0 } : ROLL}
            >
              {DIGITS.map((d) => (
                <span key={d} className="h-[1em]">
                  {d}
                </span>
              ))}
            </m.span>
          </span>
        )
      })}
    </span>
  )
}
