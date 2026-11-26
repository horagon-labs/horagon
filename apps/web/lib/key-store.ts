// Where the burner wallet and the 18+ answer live (spec sections 10 and 12), without the ed25519
// code (R5c). web3.js, which creates and checks keys, is about 111 KB gzip, so a page load reads
// the stored key and its address here and lib/burner.ts loads with the first action that needs a
// key: Buy, the faucet, Claim all, "Set up wallet", Import.
//
// Nothing here creates, imports or sends anything. The only write is openKeyStore's probe (set,
// then removed) and `affirmAge`, which only the 18+ box calls.
import bs58 from 'bs58'

export const BURNER_KEY = 'horagon.burner.v1'
export const BURNER_PREVIOUS_KEY = 'horagon.burner.v1.previous'
/** Stored as JSON `{ "affirmedAt": <ms> }`; never sent to the server. */
export const AGE_KEY = 'horagon.age18.v1'

export type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** A Solana secret key: the 32-byte ed25519 seed, then the 32-byte public key. */
export const SECRET_KEY_BYTES = 64
const PUBLIC_KEY_OFFSET = 32

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

/**
 * The bytes of a base58 secret key (Phantom export) or a JSON byte array (solana-keygen file).
 * Throws when the text is neither; the length is the caller's to check. The words for a bad
 * key are lib/burner.ts's (`secretBytes`), with the import that shows them.
 */
export function keyBytes(text: string): Uint8Array {
  const trimmed = text.trim()
  return trimmed.startsWith('[')
    ? Uint8Array.from(JSON.parse(trimmed) as number[])
    : bs58.decode(trimmed)
}

/**
 * The address of a 64-byte secret key, as web3.js's `Keypair.publicKey.toBase58()` gives it:
 * bytes 32-63 are the public key, in base58. Not checked against the seed.
 */
export function addressOf(secret: Uint8Array): string {
  if (secret.length !== SECRET_KEY_BYTES) throw new RangeError('Not a 64-byte secret key.')
  return bs58.encode(secret.subarray(PUBLIC_KEY_OFFSET))
}

/** The base58 text Export shows and Import takes back. */
export const exportSecret = (secret: Uint8Array): string => bs58.encode(secret)

/** The burner as the page knows it before any key code has loaded. */
export interface StoredBurner {
  address: string
  secretKey: Uint8Array
}

/**
 * The stored burner's address and secret key, read without the ed25519 code, or null when none
 * is stored, it does not decode, or storage cannot be read. Never writes. The halves are not
 * checked against each other here: the wallet does that once its key code loads (lib/burner.ts
 * `decodeSecret`), and a value that fails it counts as no burner there, so it never signs.
 */
export function readBurner(store: KeyStore): StoredBurner | null {
  try {
    const raw = store.getItem(BURNER_KEY)
    if (raw === null) return null
    const secretKey = keyBytes(raw)
    if (secretKey.length !== SECRET_KEY_BYTES) return null
    return { address: addressOf(secretKey), secretKey }
  } catch {
    return null
  }
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
