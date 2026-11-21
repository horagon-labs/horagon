// What the wallet must ask before it may create, import or send (spec section 12): the 18+
// self-declaration. Reads only; the flag never leaves this device.
import { ageAffirmed, type KeyStore, needsAge, peekBurner } from './burner'

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
