'use client'
// One clock for every dial (spec 5.4): a tick per second shared through useSyncExternalStore,
// paused while the tab is hidden. The store core takes its timers and visibility from `env`,
// so it runs in Node tests.
import { useSyncExternalStore } from 'react'

/** A tab hidden longer than this makes the needles jump to the new price (spec 5.3). */
export const AWAY_MS = 10_000
/** How long after the tab comes back the next price still counts as arriving "on return". */
export const RETURN_MS = 5_000

export interface ClockEnv {
  nowMs: () => number
  hidden: () => boolean
  onVisibility: (cb: () => void) => () => void
  every: (cb: () => void, ms: number) => () => void
}

export interface Clock {
  subscribe: (listener: () => void) => () => void
  /** Unix seconds; moves once a second while anything listens and the tab is visible. */
  getSnapshot: () => number
  /** True for RETURN_MS after the tab came back from more than AWAY_MS hidden. */
  justReturned: () => boolean
}

export function createClock(env: ClockEnv): Clock {
  const listeners = new Set<() => void>()
  let secs = Math.floor(env.nowMs() / 1000)
  let hiddenAt: number | null = null
  let awayMs = 0
  let backAt = Number.NEGATIVE_INFINITY
  let stopTimer: (() => void) | null = null
  let stopVisibility: (() => void) | null = null

  const tick = () => {
    const s = Math.floor(env.nowMs() / 1000)
    if (s === secs) return
    secs = s
    for (const l of listeners) l()
  }
  const start = () => {
    if (stopTimer === null && !env.hidden()) stopTimer = env.every(tick, 1_000)
  }
  const stop = () => {
    stopTimer?.()
    stopTimer = null
  }
  const onVisibility = () => {
    if (env.hidden()) {
      hiddenAt = env.nowMs()
      stop()
      return
    }
    if (hiddenAt !== null) {
      awayMs = env.nowMs() - hiddenAt
      backAt = env.nowMs()
      hiddenAt = null
    }
    tick()
    start()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) {
        // React reads the snapshot again after subscribing, so a stale second shows at once.
        secs = Math.floor(env.nowMs() / 1000)
        if (env.hidden()) hiddenAt = env.nowMs()
        stopVisibility = env.onVisibility(onVisibility)
        start()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        stop()
        stopVisibility?.()
        stopVisibility = null
      }
    },
    getSnapshot: () => secs,
    justReturned: () => awayMs > AWAY_MS && env.nowMs() - backAt < RETURN_MS,
  }
}

const browser: ClockEnv = {
  nowMs: () => Date.now(),
  hidden: () => typeof document !== 'undefined' && document.hidden,
  onVisibility: (cb) => {
    document.addEventListener('visibilitychange', cb)
    return () => document.removeEventListener('visibilitychange', cb)
  },
  every: (cb, ms) => {
    const t = setInterval(cb, ms)
    return () => clearInterval(t)
  },
}

let shared: Clock | null = null
const clock = (): Clock => {
  shared ??= createClock(browser)
  return shared
}

/**
 * Unix seconds, shared by every dial. 0 during the server render and hydration: the pages show
 * no time until their data loads in the browser.
 */
export function useNow(): number {
  const c = clock()
  return useSyncExternalStore(c.subscribe, c.getSnapshot, () => 0)
}

/** The tab just came back after more than 10 s away: needles jump instead of swinging. */
export const justReturned = (): boolean => clock().justReturned()
