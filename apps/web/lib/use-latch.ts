'use client'
// A flag that, once true, stays true while the component stays mounted (until a reload). The
// first screen holds its swap by it (components/tonight-board.tsx): once the idle face goes, it
// never comes back on this page.
import { useState } from 'react'

/** True from the first render that sees `on`, and on every render after it. */
export function useLatch(on: boolean): boolean {
  const [held, setHeld] = useState(false)
  // A state update during render, React's way to keep state in step with what a render sees: it
  // renders again before it commits, and the update runs once.
  if (on && !held) setHeld(true)
  return held || on
}
