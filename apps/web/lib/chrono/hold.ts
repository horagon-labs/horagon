// The HoldButton's rule (spec 3.2): hold 500 ms to confirm, or activate twice within 1.5 s by
// click, Enter or Space. The click that ends a completed hold is not a first activation.
export const HOLD_MS = 500
export const DOUBLE_MS = 1_500

export interface HoldState {
  /** performance.now() of the pointer going down, while it is still down. */
  downAt: number | null
  /** When the first activation happened, while the second may still come. */
  armedAt: number | null
  /** A hold just confirmed: the click that follows its release is swallowed. */
  fired: boolean
}

export const IDLE: HoldState = { downAt: null, armedAt: null, fired: false }

/** down/up/leave come from pointer events, held from the 500 ms timer, press from click. */
export type HoldInput = { kind: 'down' | 'held' | 'up' | 'leave' | 'press'; at: number }

export interface HoldResult {
  state: HoldState
  confirm: boolean
  /** A first activation: say "Press again to confirm". */
  armed: boolean
}

const CONFIRMED: HoldResult = {
  state: { downAt: null, armedAt: null, fired: true },
  confirm: true,
  armed: false,
}

export function hold(s: HoldState, i: HoldInput): HoldResult {
  const same = (state: HoldState): HoldResult => ({ state, confirm: false, armed: false })
  switch (i.kind) {
    case 'down':
      return same({ ...s, downAt: i.at, fired: false })
    case 'held':
      return s.downAt === null ? same(s) : CONFIRMED
    case 'up':
      // The timer may be throttled: a release after 500 ms confirms by itself.
      if (s.downAt !== null && i.at - s.downAt >= HOLD_MS) return CONFIRMED
      return same({ ...s, downAt: null })
    case 'leave':
      return same({ ...s, downAt: null })
    case 'press':
      if (s.fired) return same({ ...s, fired: false })
      if (s.armedAt !== null && i.at - s.armedAt <= DOUBLE_MS) {
        return { state: IDLE, confirm: true, armed: false }
      }
      return { state: { ...s, armedAt: i.at }, confirm: false, armed: true }
  }
}
