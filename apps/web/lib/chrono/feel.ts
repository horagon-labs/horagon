'use client'
// Haptics, sound and reduced motion (spec 2.5). The three choices stay on this device; storage
// may be blocked, so every read and write is guarded and falls back to the defaults.
import { useMemo, useSyncExternalStore } from 'react'

export const FEEL_KEY = 'horagon.feel.v1'
/** A bezel step and a confirmed trade (spec 2.5). */
export const STEP_BUZZ_MS = 5
export const CONFIRM_BUZZ_MS = 20
/** The desktop layout (spec 3.2, 4.1). */
export const WIDE = '(min-width: 1024px)'

export interface Feel {
  haptics: boolean
  sound: boolean
  /** null follows the system setting (prefers-reduced-motion). */
  reducedMotion: boolean | null
}

export const DEFAULT_FEEL: Feel = { haptics: true, sound: false, reducedMotion: null }

type Store = Pick<Storage, 'getItem' | 'setItem'>

export function loadFeel(store: Store | null): Feel {
  try {
    const raw = store?.getItem(FEEL_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed === null || typeof parsed !== 'object') return DEFAULT_FEEL
    const o = parsed as Record<string, unknown>
    return {
      haptics: typeof o.haptics === 'boolean' ? o.haptics : DEFAULT_FEEL.haptics,
      sound: typeof o.sound === 'boolean' ? o.sound : DEFAULT_FEEL.sound,
      reducedMotion: typeof o.reducedMotion === 'boolean' ? o.reducedMotion : null,
    }
  } catch {
    return DEFAULT_FEEL
  }
}

export function saveFeel(store: Store | null, feel: Feel): void {
  try {
    store?.setItem(FEEL_KEY, JSON.stringify(feel))
  } catch {
    // Storage blocked or full: the choice still holds for this page view.
  }
}

export const motionReduced = (feel: Feel, systemReduced: boolean): boolean =>
  feel.reducedMotion ?? systemReduced

interface Vibrator {
  vibrate?: (pattern: number) => boolean
}

export const canVibrate = (nav: Vibrator | undefined): boolean => typeof nav?.vibrate === 'function'

/** Vibrates for `ms` when the viewer allows it and the device can (Android; not iOS Safari). */
export function buzz(feel: Feel, ms: number, nav: Vibrator | undefined = globalThis.navigator) {
  if (!feel.haptics || !canVibrate(nav)) return false
  try {
    return nav?.vibrate?.(ms) ?? false
  } catch {
    return false
  }
}

/** The part of an AudioContext the tick uses. */
export interface TickAudio {
  /** "suspended" until the page has had a user gesture the browser counts. */
  readonly state: string
  resume(): Promise<unknown>
  readonly currentTime: number
  readonly destination: unknown
  createOscillator(): {
    frequency: { value: number }
    connect(node: unknown): unknown
    start(): void
    stop(when: number): void
  }
  createGain(): {
    gain: {
      setValueAtTime(value: number, time: number): unknown
      exponentialRampToValueAtTime(value: number, time: number): unknown
    }
    connect(node: unknown): unknown
  }
}

let audio: TickAudio | null = null
function browserAudio(): TickAudio | null {
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return null
  audio ??= new window.AudioContext()
  return audio
}

/** A 30 ms "tick" from an oscillator, no sound file; silent unless the viewer turned it on. */
export function playTick(feel: Feel, getAudio: () => TickAudio | null = browserAudio): boolean {
  if (!feel.sound) return false
  try {
    const ctx = getAudio()
    if (!ctx) return false
    // A context first made on a touch's pointermove (not a gesture the browser counts) starts
    // suspended and would stay silent; a refused resume only means this tick is not heard.
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = 2_400
    gain.gain.setValueAtTime(0.05, t)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(t + 0.03)
    return true
  } catch {
    return false
  }
}

/** The choices as a store, read from storage on first use (never during the server render). */
export function createFeelStore(storage: () => Store | null) {
  let feel: Feel | null = null
  const listeners = new Set<() => void>()
  const get = (): Feel => {
    feel ??= loadFeel(storage())
    return feel
  }
  return {
    get,
    set(next: Feel): void {
      feel = next
      saveFeel(storage(), next)
      for (const l of listeners) l()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

const browserStorage = (): Store | null => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const feelStore = createFeelStore(browserStorage)

/** The viewer's choices and the setter the wallet sheet's switches call. */
export function useFeel(): [Feel, (next: Feel) => void] {
  const feel = useSyncExternalStore(feelStore.subscribe, feelStore.get, () => DEFAULT_FEEL)
  return [feel, feelStore.set]
}

/** A media query, false on the server and during hydration. */
export function useMedia(query: string): boolean {
  const store = useMemo(
    () => ({
      subscribe(listener: () => void) {
        const m = window.matchMedia(query)
        m.addEventListener('change', listener)
        return () => m.removeEventListener('change', listener)
      },
      get: () => window.matchMedia(query).matches,
    }),
    [query],
  )
  return useSyncExternalStore(store.subscribe, store.get, () => false)
}

/** Reduced motion from the app's switch, else the system setting (spec 2.4). */
export function useMotionReduced(): boolean {
  const [feel] = useFeel()
  return motionReduced(feel, useMedia('(prefers-reduced-motion: reduce)'))
}
