// The devnet-only burner wallet (spec section 10): a keypair kept in localStorage as base58,
// with Export and Import. Nothing here ever throws away a key: a stored value that does not
// decode is moved aside, and an import keeps the key it replaces under BURNER_PREVIOUS_KEY.
// Every aside slot is a free one (`freeSlot`), so two writes in the same millisecond never
// share a name.
//
// The 18+ self-declaration (spec section 12) is enforced here, so the UI cannot skip it: no
// burner is created or imported until the box was ticked. The flag stays on this device.
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'

export const BURNER_KEY = 'horagon.burner.v1'
export const BURNER_PREVIOUS_KEY = 'horagon.burner.v1.previous'
/** Stored as JSON `{ "affirmedAt": <ms> }`; never sent to the server. */
export const AGE_KEY = 'horagon.age18.v1'

export type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The 18+ box has not been ticked yet; the UI asks, then calls `affirmAge` and retries. */
export class AgeRequired extends Error {
  constructor() {
    super('Confirm that you are 18 or older to create or import a wallet.')
    this.name = 'AgeRequired'
  }
}

/** True once the box was ticked. A missing, unreadable or foreign value counts as not ticked. */
export function ageAffirmed(store: KeyStore): boolean {
  try {
    const raw = store.getItem(AGE_KEY)
    if (raw === null) return false
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return false
    return typeof (parsed as { affirmedAt?: unknown }).affirmedAt === 'number'
  } catch {
    return false
  }
}

export function affirmAge(store: KeyStore, now = Date.now()): void {
  store.setItem(AGE_KEY, JSON.stringify({ affirmedAt: now }))
}

/** A burner is stored but the box was never ticked: ask once, before its next trade. */
export function needsAge(store: KeyStore): boolean {
  try {
    return store.getItem(BURNER_KEY) !== null && !ageAffirmed(store)
  } catch {
    return false
  }
}

/** A base58 secret key (Phantom export) or a JSON byte array (solana-keygen file). */
export function decodeSecret(text: string): Keypair {
  const trimmed = text.trim()
  let bytes: Uint8Array
  try {
    bytes = trimmed.startsWith('[')
      ? Uint8Array.from(JSON.parse(trimmed) as number[])
      : bs58.decode(trimmed)
  } catch {
    throw new Error('Paste a base58 secret key or a JSON array of 64 numbers.')
  }
  if (bytes.length !== 64) throw new Error(`A secret key is 64 bytes; this one is ${bytes.length}.`)
  try {
    return Keypair.fromSecretKey(bytes)
  } catch {
    throw new Error('This secret key does not match its public key.')
  }
}

export const exportBurner = (kp: Keypair): string => bs58.encode(kp.secretKey)

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

export function memoryStore(): KeyStore {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

/** Reads fall through to `base`; writes stay in memory (the browser refuses them). */
function readThrough(base: KeyStore): KeyStore {
  const memory = new Map<string, string>()
  const removed = new Set<string>()
  return {
    getItem: (k) => {
      if (memory.has(k)) return memory.get(k) ?? null
      if (removed.has(k)) return null
      try {
        return base.getItem(k)
      } catch {
        return null
      }
    },
    setItem: (k, v) => {
      removed.delete(k)
      memory.set(k, v)
    },
    removeItem: (k) => {
      memory.delete(k)
      removed.add(k)
    },
  }
}

/**
 * localStorage, or an in-memory store when the browser blocks it (Safari private mode, site
 * data policies): then the wallet and the 18+ flag last only for this tab, and the UI says so.
 * When storage can be read but not written (quota full), reads still see what is stored, so an
 * existing burner is found; new writes stay in this tab.
 */
export function openKeyStore(getStorage: () => KeyStore): { store: KeyStore; ephemeral: boolean } {
  let store: KeyStore
  try {
    store = getStorage()
  } catch {
    return { store: memoryStore(), ephemeral: true }
  }
  try {
    const probe = `${BURNER_KEY}.probe`
    store.setItem(probe, '1')
    store.removeItem(probe)
    return { store, ephemeral: false }
  } catch {
    return { store: readThrough(store), ephemeral: true }
  }
}
