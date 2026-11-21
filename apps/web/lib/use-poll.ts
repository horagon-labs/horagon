'use client'
// Polls the Horagon API (never RPC) every 3 s while the tab is visible (spec 10). Keeps the
// last good value on an error, drops answers that arrive after a newer run or a key change,
// and skips a tick while the previous run is still in flight.
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPoller } from './poller'

export const POLL_MS = 3_000

export interface Poll<T> {
  data: T | undefined
  error: Error | undefined
  refresh: () => void
}

export function usePoll<T>(key: string | null, load: () => Promise<T>, everyMs = POLL_MS): Poll<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<Error>()
  const loadRef = useRef(load)
  loadRef.current = load

  const poller = useMemo(
    () =>
      createPoller<T>(() => loadRef.current(), {
        data: (value) => {
          setData(value)
          setError(undefined)
        },
        error: setError,
      }),
    [],
  )

  useEffect(() => {
    poller.reset()
    setData(undefined)
    setError(undefined)
    if (key === null) return
    void poller.run()
    const timer = setInterval(() => {
      if (!document.hidden) void poller.tick()
    }, everyMs)
    const onVisible = () => {
      if (!document.hidden) void poller.tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      poller.reset()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [key, everyMs, poller])

  return { data, error, refresh: () => void poller.run() }
}
