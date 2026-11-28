// The latch that holds the first screen's swap (slice 5 refix 2, components/tonight-board.tsx):
// once the idle face goes, it never comes back on this page. Web tests have no DOM, so React's
// useState is stood in for by slots that keep their values from one render to the next, as a
// mounted component's do, until the next mount.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLatch } from '../lib/use-latch'

const react = vi.hoisted(() => ({ slots: [] as unknown[], at: 0, sets: 0 }))
vi.mock('react', async (actual) => ({
  ...(await actual<typeof import('react')>()),
  useState: <T>(initial: T) => {
    const i = react.at++
    if (!(i in react.slots)) react.slots[i] = initial
    const set = (value: T) => {
      react.sets++
      react.slots[i] = value
    }
    return [react.slots[i] as T, set] as const
  },
}))

/** One render of a mounted component that calls useLatch(on). */
const render = (on: boolean): boolean => {
  react.at = 0
  return useLatch(on)
}

describe('useLatch', () => {
  beforeEach(() => {
    // A new mount (a reload): no state kept.
    react.slots = []
    react.sets = 0
  })

  it('is false until `on` is first true', () => {
    expect(render(false)).toBe(false)
    expect(render(false)).toBe(false)
    expect(react.sets).toBe(0)
  })

  it('is true from the render that first sees `on`, and on every render after it', () => {
    expect(render(false)).toBe(false)
    expect(render(true)).toBe(true)
    // `on` false again (no market open once the night ends, or a gap between markets): held.
    expect(render(false)).toBe(true)
    expect(render(false)).toBe(true)
    expect(render(true)).toBe(true)
    expect(render(false)).toBe(true)
  })

  it('sets its state once, so the render-time update never loops', () => {
    render(true)
    render(true)
    render(false)
    render(true)
    expect(react.sets).toBe(1)
  })

  it('starts over on a new mount', () => {
    expect(render(true)).toBe(true)
    react.slots = []
    expect(render(false)).toBe(false)
  })

  // Slice 5 review finding 2: the board asks the server for a new frame once its own stops
  // fitting (router.refresh), and the page stays mounted. A face the old frame dropped must not
  // hide the new frame's face, so the latch holds per frame.
  const keyed = (on: boolean, key: string): boolean => {
    react.at = 0
    return useLatch(on, key)
  }

  it('starts over when its key changes (a new server frame), and holds per key', () => {
    expect(keyed(true, 'later:2026-11-27:2026-11-27')).toBe(true)
    expect(keyed(false, 'later:2026-11-27:2026-11-27')).toBe(true)
    // The refresh lands with a new frame: its face shows until it, in its turn, stops fitting.
    expect(keyed(false, 'after:2026-11-27:2026-11-28')).toBe(false)
    expect(keyed(false, 'after:2026-11-27:2026-11-28')).toBe(false)
    expect(keyed(true, 'after:2026-11-27:2026-11-28')).toBe(true)
    expect(keyed(false, 'after:2026-11-27:2026-11-28')).toBe(true)
  })

  it('sets its state once per key', () => {
    keyed(true, 'a')
    keyed(true, 'a')
    keyed(false, 'a')
    keyed(true, 'b')
    keyed(true, 'b')
    expect(react.sets).toBe(2)
  })
})
