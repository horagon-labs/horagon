import { describe, expect, it } from 'vitest'
import { AWAY_MS, type ClockEnv, createClock, RETURN_MS } from '../lib/chrono/now'

/** A hand-driven environment: time, visibility and the one-second timer. */
function fakeEnv(startMs = 1_000_000) {
  let ms = startMs
  let hidden = false
  const timers = new Set<() => void>()
  const visibility = new Set<() => void>()
  const env: ClockEnv = {
    nowMs: () => ms,
    hidden: () => hidden,
    onVisibility: (cb) => {
      visibility.add(cb)
      return () => visibility.delete(cb)
    },
    every: (cb) => {
      timers.add(cb)
      return () => timers.delete(cb)
    },
  }
  return {
    env,
    timers,
    visibility,
    advance(by: number) {
      ms += by
      for (const t of [...timers]) t()
    },
    setHidden(h: boolean) {
      hidden = h
      for (const v of [...visibility]) v()
    },
  }
}

describe('createClock (spec 5.4)', () => {
  it('ticks listeners once per new second, with one shared timer', () => {
    const f = fakeEnv()
    const clock = createClock(f.env)
    let a = 0
    let b = 0
    clock.subscribe(() => a++)
    clock.subscribe(() => b++)
    expect(f.timers.size).toBe(1)
    f.advance(400)
    expect(a).toBe(0)
    f.advance(600)
    expect([a, b]).toEqual([1, 1])
    expect(clock.getSnapshot()).toBe(1_001)
  })

  it('pauses while the tab is hidden and catches up when it shows again', () => {
    const f = fakeEnv()
    const clock = createClock(f.env)
    let n = 0
    clock.subscribe(() => n++)
    f.setHidden(true)
    expect(f.timers.size).toBe(0)
    f.advance(5_000)
    expect(n).toBe(0)
    f.setHidden(false)
    expect(n).toBe(1)
    expect(clock.getSnapshot()).toBe(1_005)
    expect(f.timers.size).toBe(1)
  })

  it('stops its timer and listener when the last subscriber leaves', () => {
    const f = fakeEnv()
    const clock = createClock(f.env)
    const off = clock.subscribe(() => {})
    expect(f.visibility.size).toBe(1)
    off()
    expect(f.timers.size).toBe(0)
    expect(f.visibility.size).toBe(0)
  })

  it('refreshes a stale second when the first listener subscribes', () => {
    const f = fakeEnv()
    const clock = createClock(f.env)
    f.advance(3_000)
    expect(clock.getSnapshot()).toBe(1_000)
    clock.subscribe(() => {})
    expect(clock.getSnapshot()).toBe(1_003)
  })

  it('says "just returned" only after more than 10 s hidden, for 5 s (spec 5.3)', () => {
    const f = fakeEnv()
    const clock = createClock(f.env)
    clock.subscribe(() => {})
    f.setHidden(true)
    f.advance(AWAY_MS)
    f.setHidden(false)
    expect(clock.justReturned()).toBe(false)
    f.setHidden(true)
    f.advance(AWAY_MS + 1)
    f.setHidden(false)
    expect(clock.justReturned()).toBe(true)
    f.advance(RETURN_MS)
    expect(clock.justReturned()).toBe(false)
  })
})
