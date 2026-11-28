'use client'
// A flag that, once true, stays true while the component stays mounted and its `key` stays the
// same. The first screen holds its swap by it (components/tonight-board.tsx): once the idle face
// goes, it never comes back for that server frame; a new frame (router.refresh) starts it over.
import { useState } from 'react'

/** True from the first render that sees `on` under `key`, and on every render after it. */
export function useLatch(on: boolean, key = ''): boolean {
  // The key the flag was set under; another key reads as not set.
  const [held, setHeld] = useState<string | null>(null)
  // A state update during render, React's way to keep state in step with what a render sees: it
  // renders again before it commits, and the update runs once per key.
  if (on && held !== key) setHeld(key)
  return held === key || on
}
