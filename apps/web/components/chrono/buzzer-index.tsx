'use client'
// The buzzer on the game screen (culture A2, R8): the hooks behind the Buzzer stop and the move
// chip, and the chip itself. The index, the ring and the ◆ are drawn by the Dial; the decisions
// are lib/chrono/stop.ts and clutch.ts.
import { useEffect, useRef, useState } from 'react'
import { CHIP_MS, moveChip } from '../../lib/chrono/clutch'
import { NEW_STOP_MEMORY, type StopMemory, stopStep } from '../../lib/chrono/stop'

/**
 * How many Buzzer stops played on this page: 0 until the page, having seen the market trade,
 * sees the buzzer; then 1. Never on load (stopStep). `onPlay` runs once, as it plays.
 */
export function useBuzzerStop(trading: boolean, buzzer: boolean, onPlay?: () => void): number {
  const memory = useRef<StopMemory>(NEW_STOP_MEMORY)
  const [played, setPlayed] = useState(0)
  const play = useRef(onPlay)
  play.current = onPlay
  useEffect(() => {
    const step = stopStep(memory.current, { trading, buzzer })
    memory.current = step.memory
    if (step.play) {
      setPlayed((n) => n + 1)
      play.current?.()
    }
  }, [trading, buzzer])
  return played
}

/** "+5" or "−5" for 3 s after a move of 3 points or more, while `live`; else null. */
export function useMoveChip(price: number | null, live: boolean): string | null {
  const last = useRef(price)
  const [chip, setChip] = useState<string | null>(null)
  useEffect(() => {
    const text = live ? moveChip(last.current, price) : null
    last.current = price
    if (!text) return
    setChip(text)
    const t = setTimeout(() => setChip(null), CHIP_MS)
    return () => clearTimeout(t)
  }, [price, live])
  return live ? chip : null
}

/** The move chip under the number: mono, ink, the sign printed (U+2212 for down). */
export function MoveChip({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <span
      className="rounded-full border border-rule px-2 font-mono text-12 tabular-nums text-ink"
      data-chip
    >
      {text}
    </span>
  )
}
