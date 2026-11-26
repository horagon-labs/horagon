// The four control states (light branding review §4.5), each on its own surface: action is an ink
// fill with paper words (the buttons spell it), selected is the sunk slot under a 2 px ink edge,
// hover darkens an edge to ink, disabled is a clear fill in a dashed rule edge with ink-muted words.
// No state is drawn by opacity. Spelled out whole so Tailwind finds every class here.
import { usdc } from '../format'

/** A control that cannot act now: clear, dashed rule edge (3.59 on the page), ink-muted words. */
export const DISABLED =
  'disabled:border disabled:border-dashed disabled:border-line disabled:bg-transparent disabled:text-ash-400'

/** The picked one of a set (`aria-pressed`): the sunk slot and a 2 px ink edge (14.90 inside). */
export const SELECTED =
  'aria-pressed:border-2 aria-pressed:border-ivory-100 aria-pressed:bg-enamel-800'

/**
 * A change in mUSDC with its sign printed, "+0.85" or "−1.20" (U+2212): gains and losses weigh the
 * same and share one ink, so the sign carries the direction (u3 D2).
 */
export function signedUsdc(amount: string): string {
  const text = amount.trim()
  const down = text.startsWith('-')
  return `${down ? '−' : '+'}${usdc(down ? text.slice(1) : text)}`
}
