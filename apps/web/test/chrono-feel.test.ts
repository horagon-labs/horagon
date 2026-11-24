import { describe, expect, it, vi } from 'vitest'
import {
  canVibrate,
  createFeelStore,
  DEFAULT_FEEL,
  FEEL_KEY,
  type Feel,
  loadFeel,
  motionReduced,
  saveFeel,
} from '../lib/chrono/feel'

function store(initial?: string) {
  const map = new Map<string, string>()
  if (initial !== undefined) map.set(FEEL_KEY, initial)
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

const blocked = {
  getItem: () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  },
  setItem: () => {
    throw new DOMException('Quota exceeded', 'QuotaExceededError')
  },
}

describe('feel preferences (spec 2.5)', () => {
  it('defaults to haptics on, sound off, motion from the system', () => {
    expect(DEFAULT_FEEL).toEqual({ haptics: true, sound: false, reducedMotion: null })
    expect(loadFeel(store())).toEqual(DEFAULT_FEEL)
    expect(loadFeel(null)).toEqual(DEFAULT_FEEL)
  })

  it('round-trips through storage', () => {
    const s = store()
    const feel: Feel = { haptics: false, sound: true, reducedMotion: true }
    saveFeel(s, feel)
    expect(loadFeel(s)).toEqual(feel)
  })

  it('reads corrupt or foreign values field by field, falling back to the defaults', () => {
    for (const raw of ['{', '"x"', 'null', '[]']) expect(loadFeel(store(raw))).toEqual(DEFAULT_FEEL)
    expect(loadFeel(store('{"sound":true,"haptics":"yes","reducedMotion":1}'))).toEqual({
      haptics: true,
      sound: true,
      reducedMotion: null,
    })
  })

  it('never throws when storage is blocked or full', () => {
    expect(loadFeel(blocked)).toEqual(DEFAULT_FEEL)
    expect(() => saveFeel(blocked, DEFAULT_FEEL)).not.toThrow()
  })

  it('lets the app switch override the system reduced-motion setting', () => {
    expect(motionReduced(DEFAULT_FEEL, true)).toBe(true)
    expect(motionReduced(DEFAULT_FEEL, false)).toBe(false)
    expect(motionReduced({ ...DEFAULT_FEEL, reducedMotion: false }, true)).toBe(false)
    expect(motionReduced({ ...DEFAULT_FEEL, reducedMotion: true }, false)).toBe(true)
  })

  it('tells whether the device can vibrate, for the haptics switch', () => {
    expect(canVibrate({ vibrate: () => true })).toBe(true)
    expect(canVibrate({})).toBe(false)
    expect(canVibrate(undefined)).toBe(false)
  })
})

describe('createFeelStore', () => {
  it('reads storage on first use, saves and notifies on set', () => {
    const s = store('{"sound":true}')
    const getStorage = vi.fn(() => s)
    const feel = createFeelStore(getStorage)
    expect(getStorage).not.toHaveBeenCalled()
    expect(feel.get().sound).toBe(true)
    let heard = 0
    const off = feel.subscribe(() => heard++)
    feel.set({ ...DEFAULT_FEEL, haptics: false })
    expect(heard).toBe(1)
    expect(JSON.parse(s.map.get(FEEL_KEY) ?? '{}')).toEqual({
      haptics: false,
      sound: false,
      reducedMotion: null,
    })
    off()
    feel.set(DEFAULT_FEEL)
    expect(heard).toBe(1)
  })
})
