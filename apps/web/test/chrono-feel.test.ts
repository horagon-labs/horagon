import { describe, expect, it, vi } from 'vitest'
import {
  buzz,
  canVibrate,
  createFeelStore,
  DEFAULT_FEEL,
  FEEL_KEY,
  type Feel,
  loadFeel,
  motionReduced,
  playTick,
  saveFeel,
  type TickAudio,
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
})

describe('buzz', () => {
  it('vibrates only when allowed and supported', () => {
    const vibrate = vi.fn(() => true)
    expect(buzz(DEFAULT_FEEL, 5, { vibrate })).toBe(true)
    expect(vibrate).toHaveBeenCalledWith(5)
    expect(buzz({ ...DEFAULT_FEEL, haptics: false }, 5, { vibrate })).toBe(false)
    expect(vibrate).toHaveBeenCalledTimes(1)
    expect(buzz(DEFAULT_FEEL, 5, {})).toBe(false)
    expect(buzz(DEFAULT_FEEL, 5, undefined)).toBe(false)
    expect(canVibrate({ vibrate })).toBe(true)
    expect(canVibrate({})).toBe(false)
  })

  it('swallows a vibrate that throws', () => {
    const vibrate = () => {
      throw new Error('blocked')
    }
    expect(buzz(DEFAULT_FEEL, 20, { vibrate })).toBe(false)
  })
})

describe('playTick', () => {
  function fakeAudio(state = 'running') {
    const calls: string[] = []
    const audio: TickAudio = {
      state,
      resume: async () => {
        calls.push('resume')
      },
      currentTime: 2,
      destination: 'speakers',
      createOscillator: () => ({
        frequency: { value: 0 },
        connect: () => calls.push('osc.connect'),
        start: () => calls.push('start'),
        stop: (when) => calls.push(`stop@${when}`),
      }),
      createGain: () => ({
        gain: {
          setValueAtTime: () => calls.push('gain.set'),
          exponentialRampToValueAtTime: () => calls.push('gain.ramp'),
        },
        connect: (node) => calls.push(`gain.connect:${String(node)}`),
      }),
    }
    return { audio, calls }
  }

  it('is silent by default and never opens audio then', () => {
    const getAudio = vi.fn(() => null)
    expect(playTick(DEFAULT_FEEL, getAudio)).toBe(false)
    expect(getAudio).not.toHaveBeenCalled()
  })

  it('plays a 30 ms oscillator tick when sound is on', () => {
    const { audio, calls } = fakeAudio()
    expect(playTick({ ...DEFAULT_FEEL, sound: true }, () => audio)).toBe(true)
    expect(calls).toEqual([
      'gain.set',
      'gain.ramp',
      'osc.connect',
      'gain.connect:speakers',
      'start',
      'stop@2.03',
    ])
  })

  it('resumes a context the browser left suspended, then ticks (M14)', () => {
    const { audio, calls } = fakeAudio('suspended')
    expect(playTick({ ...DEFAULT_FEEL, sound: true }, () => audio)).toBe(true)
    expect(calls[0]).toBe('resume')
    expect(calls).toContain('start')
  })

  it('survives a resume the browser refuses', async () => {
    const { audio } = fakeAudio('suspended')
    const refused = { ...audio, resume: () => Promise.reject(new Error('NotAllowedError')) }
    expect(playTick({ ...DEFAULT_FEEL, sound: true }, () => refused)).toBe(true)
    await Promise.resolve()
  })

  it('does nothing without audio support, and survives an audio error', () => {
    expect(playTick({ ...DEFAULT_FEEL, sound: true }, () => null)).toBe(false)
    const broken = () => {
      throw new Error('NotAllowedError')
    }
    expect(playTick({ ...DEFAULT_FEEL, sound: true }, broken)).toBe(false)
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
