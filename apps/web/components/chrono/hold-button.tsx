'use client'
// Hold 500 ms to confirm, with a progress ring; or press twice within 1.5 s by click, Enter or
// Space (spec 3.2, 2.6). `hold-safe` stops iOS from selecting text or opening its callout. The
// ring is `keep-motion`: it is the button's meaning, not decoration, so reduced motion keeps it.
import { useEffect, useRef, useState } from 'react'
import { useFeel } from '../../lib/chrono/feel'
import { buzz, CONFIRM_BUZZ_MS } from '../../lib/chrono/haptics'
import { DOUBLE_MS, HOLD_MS, type HoldInput, hold, IDLE } from '../../lib/chrono/hold'

export const AGAIN = 'Press again to confirm'

export function HoldButton(p: {
  label: string
  onConfirm: () => void
  disabled?: boolean
  /** A send is in flight: the only optimistic part of a trade (spec 5.5). */
  pending?: boolean
  /** A hold or a first press began: the caller may start loading what the send needs. */
  onPressStart?: () => void
  tone?: 'lume' | 'brass'
  className?: string
}) {
  const [feel] = useFeel()
  const state = useRef(IDLE)
  const [pressing, setPressing] = useState(false)
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const disarm = useRef<ReturnType<typeof setTimeout>>(undefined)
  const off = p.disabled || p.pending
  // The timers outlive a render: keep the latest of what they call.
  const onConfirmRef = useRef(p.onConfirm)
  onConfirmRef.current = p.onConfirm
  const feelRef = useRef(feel)
  feelRef.current = feel
  const offRef = useRef(off)
  offRef.current = off
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      clearTimeout(disarm.current)
    },
    [],
  )
  // Once the button is off (halted, or a send in flight) no hold or first press may complete.
  useEffect(() => {
    if (!off) return
    clearTimeout(timer.current)
    clearTimeout(disarm.current)
    state.current = IDLE
    setPressing(false)
    setArmed(false)
  }, [off])

  function apply(kind: HoldInput['kind']) {
    const r = hold(state.current, { kind, at: performance.now() })
    state.current = r.state
    setPressing(r.state.downAt !== null)
    if (r.armed) {
      setArmed(true)
      clearTimeout(disarm.current)
      disarm.current = setTimeout(() => setArmed(false), DOUBLE_MS)
    }
    if (r.confirm) {
      clearTimeout(timer.current)
      setArmed(false)
      if (offRef.current) return
      buzz(feelRef.current, CONFIRM_BUZZ_MS)
      onConfirmRef.current()
    }
  }

  const release = (kind: 'up' | 'leave') => {
    clearTimeout(timer.current)
    apply(kind)
  }
  return (
    <div className={p.className}>
      <button
        type="button"
        disabled={off}
        onPointerDown={(e) => {
          if (off || e.button !== 0) return
          p.onPressStart?.()
          apply('down')
          timer.current = setTimeout(() => apply('held'), HOLD_MS)
        }}
        onPointerUp={() => release('up')}
        onPointerLeave={() => release('leave')}
        onPointerCancel={() => release('leave')}
        onClick={() => apply('press')}
        onContextMenu={(e) => e.preventDefault()}
        data-pressing={pressing ? 'true' : undefined}
        className={`hold-safe flex min-h-14 w-full items-center justify-center gap-3 rounded-card px-4 text-15 font-semibold text-enamel-950 disabled:opacity-50 ${
          p.tone === 'brass' ? 'bg-brass-500' : 'bg-lume-300'
        }`}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          className={`size-6 shrink-0 ${p.pending ? 'animate-spin' : ''}`}
        >
          <circle
            cx={12}
            cy={12}
            r={10}
            fill="none"
            strokeWidth={2.5}
            className="stroke-enamel-950/25"
          />
          <circle
            cx={12}
            cy={12}
            r={10}
            fill="none"
            strokeWidth={2.5}
            pathLength={100}
            strokeDasharray="100"
            strokeDashoffset={p.pending ? 70 : pressing ? 0 : 100}
            transform="rotate(-90 12 12)"
            className={`keep-motion stroke-enamel-950 ${
              pressing ? 'transition-[stroke-dashoffset] duration-500 ease-linear' : ''
            }`}
            data-progress
          />
        </svg>
        {armed ? AGAIN : p.label}
      </button>
      <span aria-live="polite" className="sr-only">
        {armed ? AGAIN : ''}
      </span>
    </div>
  )
}
