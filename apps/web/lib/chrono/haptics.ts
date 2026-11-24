// The game screen's buzz and tick (spec 2.5), for the bezel and the HoldButton only. Kept out of
// feel.ts so the board, which shows the feel switches but never buzzes, does not load them.
import { canVibrate, type Feel, type Vibrator } from './feel'

/** A bezel step and a confirmed trade (spec 2.5). */
export const STEP_BUZZ_MS = 5
export const CONFIRM_BUZZ_MS = 20

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
