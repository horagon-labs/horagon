// What the wallet must ask before it may create, import or send (spec section 12): the 18+
// self-declaration. The flag never leaves this device.
//
// When it asks (R5): never on a page load. A first visit reads the board and the game pages
// with no prompt and no wallet; the question comes with the first action that creates or uses a
// wallet (Buy, the faucet, "Set up wallet", Import), inline in the crown where it can be and in
// the AgeDialog otherwise. Nothing is created, imported or sent before the box is ticked.
import type { Keypair } from '@solana/web3.js'
import { affirmAge, ageAffirmed, ensureBurner, type KeyStore, needsAge, peekBurner } from './burner'

/**
 * - `ask-new`: no usable burner and no flag. Ask before creating one.
 * - `ask-existing`: a burner is stored but the box was never ticked. Load it, and ask before
 *   its next trade, claim or faucet request.
 * - `ready`: the box was ticked (a missing burner can be created without asking).
 *
 * A stored value that does not decode counts as no burner: replacing it is a creation.
 */
export type WalletGate = 'ask-new' | 'ask-existing' | 'ready'

export function walletGate(store: KeyStore): WalletGate {
  if (peekBurner(store) === null) return ageAffirmed(store) ? 'ready' : 'ask-new'
  return needsAge(store) ? 'ask-existing' : 'ready'
}

/** What waits behind the gate: a trade, a Claim all run, or a faucet request. */
export type GateAction = 'trade' | 'claim' | 'faucet'

/**
 * After the box is ticked: does the action that opened the gate go ahead? When the gate just
 * created the burner (`created`), the wallet is empty, so only a faucet request can succeed;
 * a trade or a claim is dropped and the UI points to the faucet instead.
 */
export function afterGate(action: GateAction, created: boolean): 'continue' | 'drop' {
  return created && action !== 'faucet' ? 'drop' : 'continue'
}

/**
 * Another tab changed the wallet keys while this tab's gate was open. It closes when that tab
 * stored a readable burner and ticked the box, unless an action here is still waiting for it.
 */
export function gateClosesOnSync(store: KeyStore, pending: boolean): boolean {
  return !pending && peekBurner(store) !== null && ageAffirmed(store)
}

/**
 * A page load (R5): never asks. A stored burner loads (asked or not: its first send asks); a
 * device that ticked the box before gets its missing burner back; a first visit writes nothing
 * and has no burner until an action asks. Null too when storage refuses a burner it may create.
 */
export function loadWallet(store: KeyStore): Keypair | null {
  if (walletGate(store) === 'ask-new') return null
  try {
    return ensureBurner(store)
  } catch {
    return null
  }
}

/**
 * The box was ticked (in the AgeDialog or inline in the crown): the flag is set, then the burner
 * is read or created. `created` says it is new, hence empty. Throws when storage refuses it.
 */
export function confirmAge(store: KeyStore): { keypair: Keypair; created: boolean } {
  const created = peekBurner(store) === null
  affirmAge(store)
  return { keypair: ensureBurner(store), created }
}

/** Something that sends with the burner: a trade, a claim, a faucet request. */
export type Send = (keypair: Keypair) => void

interface Pending {
  send: Send
  action: GateAction
}

/**
 * The action the gate lets through, for the caller to run once its own bookkeeping is done (and
 * outside any catch of a save, R5 review finding 11); null when `afterGate` dropped it.
 */
export type Go = (() => void) | null

/** What a request did: it asks (the caller shows the question), or the burner may go ahead. */
export type GateOutcome = { ask: true } | { ask: false; keypair: Keypair; created: boolean; go: Go }

const goWith =
  (send: Send, keypair: Keypair): Go =>
  () =>
    send(keypair)

/**
 * The gate's one waiting action and the rules around it, without React. The gate saves (the
 * flag, a new burner) but never sends itself: it hands back `go`, so an error a send throws is
 * never taken for a refused save.
 * - `request` lets the action go at once when the burner exists and the box was ticked.
 *   Otherwise it keeps the action and asks; a new request replaces the waiting one.
 * - `affirmedHere`: the crown's own box was ticked for this very action (inline ask). The flag
 *   is set, a missing burner is created, and the action goes as `afterGate` says.
 * - `confirm` (the AgeDialog's box ticked) creates the burner and lets the waiting action go.
 * Nothing is created or let through on any other path.
 */
export function createAgeGate() {
  let pending: Pending | null = null
  return {
    /** Throws, keeping nothing, when storage refuses the flag or the burner of `affirmedHere`. */
    request(
      store: KeyStore,
      keypair: Keypair | null,
      send: Send,
      action: GateAction,
      affirmedHere = false,
    ): GateOutcome {
      if (affirmedHere) {
        pending = null
        const r = confirmAge(store)
        const go = afterGate(action, r.created) === 'continue' ? goWith(send, r.keypair) : null
        return { ask: false, ...r, go }
      }
      // The stored flag is the truth (another tab may have changed it since the last render).
      if (keypair && ageAffirmed(store)) {
        return { ask: false, keypair, created: false, go: goWith(send, keypair) }
      }
      pending = { send, action }
      return { ask: true }
    },
    /** Asks with nothing to continue ("Set up wallet", Import without the box). */
    askOnly(): void {
      pending = null
    },
    waiting: (): boolean => pending !== null,
    cancel(): void {
      pending = null
    },
    /**
     * The box was ticked. Throws when storage refuses the flag or the burner; the action keeps
     * waiting then, so a second Continue can still carry it.
     */
    confirm(store: KeyStore): { keypair: Keypair; created: boolean; go: Go } {
      const r = confirmAge(store)
      const next = pending
      pending = null
      const go =
        next && afterGate(next.action, r.created) === 'continue'
          ? goWith(next.send, r.keypair)
          : null
      return { ...r, go }
    },
  }
}

export type AgeGate = ReturnType<typeof createAgeGate>
