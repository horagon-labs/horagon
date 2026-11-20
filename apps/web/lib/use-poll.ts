'use client'
// Polls the Horagon API (never RPC) every 3 s while the tab is visible (spec 10). Keeps the
// last good value on an error, and drops answers that arrive after the key changed.
import { useCallback, useEffect, useRef, useState } from 'react'

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
  const gen = useRef(0)

  const run = useCallback(async () => {
    const mine = gen.current
    try {
      const value = await loadRef.current()
      if (mine !== gen.current) return
      setData(value)
      setError(undefined)
    } catch (err) {
      if (mine === gen.current) setError(err instanceof Error ? err : new Error(String(err)))
    }
  }, [])

  useEffect(() => {
    gen.current++
    setData(undefined)
    setError(undefined)
    if (key === null) return
    void run()
    const timer = setInterval(() => {
      if (!document.hidden) void run()
    }, everyMs)
    const onVisible = () => {
      if (!document.hidden) void run()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      gen.current++
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [key, everyMs, run])

  return { data, error, refresh: () => void run() }
}
