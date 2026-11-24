// The HoldButton's rule (spec 3.2): hold 500 ms to confirm, or activate twice within 1.5 s by
// click, Enter or Space. The click that ends a completed hold is not a first activation.
export const HOLD_MS = 500
export const DOUBLE_MS = 1_500
// The click that ends a hold follows its release within a few ms.
export const SWALLOW_MS = 1_000

export interface HoldState {
  /** performance.now() of the pointer going down, while it is still down. */
  downAt: number | null
  /** When the first activation happened, while the second may still come. */
  armedAt: number | null
  /** When a hold confirmed (then when it was released): the click right after is swallowed. */
  firedAt: number | null
}

export const IDLE: HoldState = { downAt: null, armedAt: null, firedAt: null }

/** down/up/leave come from pointer events, held from the 500 ms timer, press from click. */
export type HoldInput = { kind: 'down' | 'held' | 'up' | 'leave' | 'press'; at: number }

export interface HoldResult {
  state: HoldState
  confirm: boolean
  /** A first activation: say "Press again to confirm". */
  armed: boolean
}

const confirmed = (at: number): HoldResult => ({
  state: { downAt: null, armedAt: null, firedAt: at },
  confirm: true,
  armed: false,
})

export function hold(s: HoldState, i: HoldInput): HoldResult {
  const same = (state: HoldState): HoldResult => ({ state, confirm: false, armed: false })
  switch (i.kind) {
    case 'down':
      return same({ ...s, downAt: i.at, firedAt: null })
    case 'held':
      return s.downAt === null ? same(s) : confirmed(i.at)
    case 'up':
      // The timer may be throttled: a release after 500 ms confirms by itself.
      if (s.downAt !== null && i.at - s.downAt >= HOLD_MS) return confirmed(i.at)
      // The release is when the swallowed click is due, however long the hold lasted.
      return same({ ...s, downAt: null, firedAt: s.firedAt === null ? null : i.at })
    case 'leave':
      return same({ ...s, downAt: null })
    case 'press':
      if (s.firedAt !== null && i.at - s.firedAt <= SWALLOW_MS) {
        return same({ ...s, firedAt: null })
      }
      if (s.armedAt !== null && i.at - s.armedAt <= DOUBLE_MS) {
        return { state: IDLE, confirm: true, armed: false }
      }
      return { state: { ...s, armedAt: i.at, firedAt: null }, confirm: false, armed: true }
  }
}
