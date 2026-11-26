// The devnet-only burner wallet (spec section 10): a keypair kept in localStorage as base58,
// with Export and Import. Nothing here ever throws away a key: a stored value that does not
// decode is moved aside, and an import keeps the key it replaces under BURNER_PREVIOUS_KEY.
// Every aside slot is a free one (`freeSlot`), so two writes in the same millisecond never
// share a name.
//
// The 18+ self-declaration (spec section 12) is enforced here, so the UI cannot skip it: no
// burner is created or imported until the box was ticked. The flag stays on this device.
//
// This module creates and checks keys with web3.js's Keypair, so it loads with the first action
// that needs a key (R5c, lib/wallet-loader.ts), never on a page load. The storage itself and the
// address of a stored key are in lib/key-store.ts, which needs no ed25519 code.
import { Keypair } from '@solana/web3.js'
import {
  ageAffirmed,
  BURNER_KEY,
  BURNER_PREVIOUS_KEY,
  exportSecret,
  type KeyStore,
  keyBytes,
  SECRET_KEY_BYTES,
} from './key-store'

export {
  AGE_KEY,
  affirmAge,
  ageAffirmed,
  BURNER_KEY,
  BURNER_PREVIOUS_KEY,
  type KeyStore,
  memoryStore,
  needsAge,
  openKeyStore,
} from './key-store'

/** The 18+ box has not been ticked yet; the UI asks, then calls `affirmAge` and retries. */
export class AgeRequired extends Error {
  constructor() {
    super('Confirm that you are 18 or older to create or import a wallet.')
    this.name = 'AgeRequired'
  }
}

/**
 * The 64 bytes of a pasted or stored secret key, or an Error that says what is wrong with it.
 * Only the length is checked here; `decodeSecret` also checks the public key half.
 */
export function secretBytes(text: string): Uint8Array {
  let bytes: Uint8Array
  try {
    bytes = keyBytes(text)
  } catch {
    throw new Error('Paste a base58 secret key or a JSON array of 64 numbers.')
  }
  if (bytes.length !== SECRET_KEY_BYTES) {
    throw new Error(`A secret key is 64 bytes; this one is ${bytes.length}.`)
  }
  return bytes
}

/** A base58 secret key (Phantom export) or a JSON byte array (solana-keygen file). */
export function decodeSecret(text: string): Keypair {
  const bytes = secretBytes(text)
  try {
    return Keypair.fromSecretKey(bytes)
  } catch {
    throw new Error('This secret key does not match its public key.')
  }
}

export const exportBurner = (kp: Keypair): string => exportSecret(kp.secretKey)

/**
 * The stored burner, or null when none is stored, the value does not decode, or storage cannot
 * be read. Never writes and never creates one: the UI uses it to decide whether to ask first.
 */
export function peekBurner(store: KeyStore): Keypair | null {
  try {
    const raw = store.getItem(BURNER_KEY)
    return raw === null ? null : decodeSecret(raw)
  } catch {
    return null
  }
}

/** `base`, or `base.1`, `base.2`, ...: the first name that holds nothing yet. */
function freeSlot(store: KeyStore, base: string): string {
  if (store.getItem(base) === null) return base
  for (let n = 1; ; n++) {
    const name = `${base}.${n}`
    if (store.getItem(name) === null) return name
  }
}

function save(store: KeyStore, kp: Keypair): Keypair {
  store.setItem(BURNER_KEY, exportBurner(kp))
  return kp
}

/**
 * The stored burner, or a new one. A stored burner is returned whether or not the box was
 * ticked (`needsAge` tells the UI to ask). Creating one needs the box: otherwise this throws
 * `AgeRequired` and writes nothing. A stored value that does not decode is kept aside.
 */
export function ensureBurner(store: KeyStore, now = Date.now()): Keypair {
  const raw = store.getItem(BURNER_KEY)
  if (raw !== null) {
    try {
      return decodeSecret(raw)
    } catch {
      // Falls through to a new key, which needs the box ticked like any other creation.
    }
  }
  if (!ageAffirmed(store)) throw new AgeRequired()
  if (raw !== null) store.setItem(freeSlot(store, `${BURNER_KEY}.unreadable.${now}`), raw)
  return save(store, Keypair.generate())
}

/**
 * Replaces the burner. The key it replaces moves to BURNER_PREVIOUS_KEY; a key already in that
 * slot moves to a free timestamped slot first, and an unreadable current value is set aside
 * under its own name, so no import ever drops a key. The text is checked first, so a bad key is
 * reported as such; then the box must be ticked.
 */
export function importBurner(store: KeyStore, text: string, now = Date.now()): Keypair {
  const next = decodeSecret(text)
  if (!ageAffirmed(store)) throw new AgeRequired()
  const current = store.getItem(BURNER_KEY)
  const incoming = exportBurner(next)
  if (current !== null && current !== incoming) {
    let readable = true
    try {
      decodeSecret(current)
    } catch {
      readable = false
    }
    if (!readable) {
      store.setItem(freeSlot(store, `${BURNER_KEY}.unreadable.${now}`), current)
    } else {
      const previous = store.getItem(BURNER_PREVIOUS_KEY)
      if (previous !== null && previous !== current && previous !== incoming) {
        store.setItem(freeSlot(store, `${BURNER_PREVIOUS_KEY}.${now}`), previous)
      }
      store.setItem(BURNER_PREVIOUS_KEY, current)
    }
  }
  return save(store, next)
}
