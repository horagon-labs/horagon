'use client'
// The Practice card's score and price (first-screen W8b): a text island that reads GET /practice
// every 15 s while the run is on, and stops at its Final or once it is no longer the current run;
// then it marks the run over and the card gives way (slice 6 refix 1). Its first frame is the
// server's read, so hydration matches. Moving numbers are mono (culture rule); ink, never Live
// blue: on `/` blue means an NBA market is open (§4).
import type { Game } from '@horagon/sdk'
import { useState } from 'react'
import { api } from '../../lib/api'
import { practicePrice, practiceScore } from '../../lib/chrono/practice-live'
import { usePoll } from '../../lib/use-poll'

/** A replay runs at 6x: one read every 15 s is 90 s of game clock, enough for a score line. */
export const PRACTICE_POLL_MS = 15_000

export function PracticeLive({ run }: { run: Game }) {
  // The run as last read; null once it is no longer the current run.
  const [shown, setShown] = useState<Game | null>(run)
  const on = shown !== null && shown.status !== 'final'
  const poll = usePoll(on ? 'practice' : null, () => api.practice(), PRACTICE_POLL_MS)
  const read = on ? poll.data : undefined
  if (read) {
    // Each answer is a new object; a price can move with no new game row, so any answer counts.
    const next = read.current?.id === run.id ? read.current : null
    // React's update during render: one more render with the newer read, then it settles.
    if (next !== shown) setShown(next)
  }
  // Over on an open page (its Final, or /practice moved on to another run or none): a mark the
  // stylesheet reads to hide the whole card (globals.css), so "Practice game live" and "Play
  // along" never stand over a Final score. No words of its own, no style attribute (R9 CSP).
  if (!shown) return <span hidden data-practice-over="" />
  const score = practiceScore(shown)
  const price = practicePrice(shown)
  if (!score && !price) return null
  return (
    <div className="text-13 text-ink" data-practice-live data-practice-over={on ? undefined : ''}>
      {score && <p className="font-mono tabular-nums">{score}</p>}
      {price && (
        <p>
          {price.subject} <span className="font-mono tabular-nums">{price.value}</span>
        </p>
      )}
    </div>
  )
}
