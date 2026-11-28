// The first screen asks the server for a new frame once the one it shows stops fitting (slice 5
// review finding 2, components/tonight-board.tsx): at most once per frame, so a refresh that brings
// the same frame back never asks again, and no render loop can come of it. Web tests have no DOM,
// so React's useRef and useEffect are stood in for by slots that keep their values from one render
// to the next, as a mounted component's do, with each effect run after its render when its
// dependencies changed (React's rule); the router is a stub.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRefresh } from '../lib/use-refresh'

const react = vi.hoisted(() => ({
  slots: [] as unknown[],
  at: 0,
  effects: [] as Array<() => void>,
}))
vi.mock('react', async (actual) => ({
  ...(await actual<typeof import('react')>()),
  useRef: <T>(initial: T) => {
    const i = react.at++
    if (!(i in react.slots)) react.slots[i] = { current: initial }
    return react.slots[i]
  },
  useEffect: (effect: () => void, deps?: readonly unknown[]) => {
    const i = react.at++
    const before = react.slots[i] as readonly unknown[] | undefined
    react.slots[i] = deps
    if (!before || !deps || deps.some((d, k) => !Object.is(d, before[k]))) {
      react.effects.push(effect)
    }
  },
}))

const router = vi.hoisted(() => ({ refresh: vi.fn(), fresh: false }))
vi.mock('next/navigation', () => ({
  // `fresh`: a new router object on every render, as a context value may be.
  useRouter: () => (router.fresh ? { refresh: router.refresh } : router),
}))

/** One render of a mounted component that calls useRefresh(due, key), then its commit. */
const render = (due: boolean, key: string) => {
  react.at = 0
  react.effects = []
  useRefresh(due, key)
  for (const effect of react.effects) effect()
}
const asked = () => router.refresh.mock.calls.length

describe('useRefresh', () => {
  beforeEach(() => {
    // A new mount (a reload): nothing asked yet.
    react.slots = []
    router.refresh.mockClear()
    router.fresh = false
  })

  it('asks nothing while the frame fits', () => {
    render(false, 'after:2026-11-27:2026-11-28')
    render(false, 'after:2026-11-27:2026-11-28')
    expect(asked()).toBe(0)
  })

  it('asks once when the frame stops fitting, and not on the renders after it', () => {
    const s5 = 'after:2026-11-27:2026-11-28'
    render(false, s5)
    render(true, s5)
    expect(asked()).toBe(1)
    // Every clock tick and poll renders again while the refresh is on its way.
    render(true, s5)
    render(true, s5)
    render(true, s5)
    render(true, s5)
    expect(asked()).toBe(1)
    // A face that goes and comes back under the same frame (a gap between markets).
    render(false, s5)
    render(true, s5)
    expect(asked()).toBe(1)
  })

  it('does not loop when the refresh brings the same frame back', () => {
    router.fresh = true
    // The server's clock a few seconds behind the browser's: the same state, night and date.
    const s5 = 'after:2026-11-27:2026-11-28'
    render(true, s5)
    render(true, s5)
    render(true, s5)
    expect(asked()).toBe(1)
  })

  it('asks once more for a new frame only if it is stale too, never again for an old one', () => {
    render(true, 'later:2026-11-27:2026-11-27')
    expect(asked()).toBe(1)
    // The new frame fits: nothing more.
    render(false, 'preopen:2026-11-27:2026-11-27')
    expect(asked()).toBe(1)
    // At midnight ET it stops fitting in its turn.
    render(true, 'preopen:2026-11-27:2026-11-27')
    expect(asked()).toBe(2)
    // A server flipping back to a frame it already sent is not asked again.
    render(true, 'later:2026-11-27:2026-11-27')
    expect(asked()).toBe(2)
  })

  it('starts over on a new mount (a reload, or a page restored by going back)', () => {
    render(true, 'after:2026-11-27:2026-11-28')
    react.slots = []
    render(true, 'after:2026-11-27:2026-11-28')
    expect(asked()).toBe(2)
  })
})
