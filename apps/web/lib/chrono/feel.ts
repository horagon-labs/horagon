'use client'
// Haptics, sound and reduced motion (spec 2.5). The three choices stay on this device; storage
// may be blocked, so every read and write is guarded and falls back to the defaults. The buzz
// and the tick themselves are the game screen's, in haptics.ts.
import { useMemo, useSyncExternalStore } from 'react'

export const FEEL_KEY = 'horagon.feel.v1'
/** The desktop layout (spec 3.2, 4.1). */
export const WIDE = '(min-width: 1024px)'

export interface Feel {
  haptics: boolean
  sound: boolean
  /** null follows the system setting (prefers-reduced-motion). */
  reducedMotion: boolean | null
  /** "Dim the screen in clutch time" (A2, R8), on by default. */
  clutchDim: boolean
}

export const DEFAULT_FEEL: Feel = {
  haptics: true,
  sound: false,
  reducedMotion: null,
  clutchDim: true,
}

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
      clutchDim: typeof o.clutchDim === 'boolean' ? o.clutchDim : DEFAULT_FEEL.clutchDim,
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

export interface Vibrator {
  vibrate?: (pattern: number | number[]) => boolean
}

/** Whether the device can vibrate: the wallet sheet's haptics switch needs it (haptics.ts buzzes). */
export const canVibrate = (nav: Vibrator | undefined): boolean => typeof nav?.vibrate === 'function'

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
