import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEEL } from '../lib/chrono/feel'
import {
  buzz,
  CONFIRM_BUZZ_MS,
  playTick,
  STEP_BUZZ_MS,
  type TickAudio,
} from '../lib/chrono/haptics'

describe('buzz (spec 2.5)', () => {
  it('buzzes 5 ms for a bezel step and 20 ms for a confirmed trade', () => {
    expect([STEP_BUZZ_MS, CONFIRM_BUZZ_MS]).toEqual([5, 20])
  })

  it('vibrates only when allowed and supported', () => {
    const vibrate = vi.fn(() => true)
    expect(buzz(DEFAULT_FEEL, 5, { vibrate })).toBe(true)
    expect(vibrate).toHaveBeenCalledWith(5)
    expect(buzz({ ...DEFAULT_FEEL, haptics: false }, 5, { vibrate })).toBe(false)
    expect(vibrate).toHaveBeenCalledTimes(1)
    expect(buzz(DEFAULT_FEEL, 5, {})).toBe(false)
    expect(buzz(DEFAULT_FEEL, 5, undefined)).toBe(false)
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

describe('haptics.ts stays off the board (I1b)', () => {
  const web = join(import.meta.dirname, '..')
  const sources = (dir: string): string[] =>
    readdirSync(join(web, dir), { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => join(dir, f).replaceAll('\\', '/'))

  it('is imported by the bezel, the HoldButton and the game screen only (A2 Buzzer stop)', () => {
    const importers = [...sources('app'), ...sources('components'), ...sources('lib')].filter((f) =>
      /from '[./]+(lib\/chrono\/|chrono\/)?haptics'/.test(readFileSync(join(web, f), 'utf8')),
    )
    expect(importers.sort()).toEqual([
      'components/chrono/bezel.tsx',
      'components/chrono/game-screen.tsx',
      'components/chrono/hold-button.tsx',
    ])
  })
})
