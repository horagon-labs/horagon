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
