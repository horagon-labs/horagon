import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
import {
  AGE_KEY,
  AgeRequired,
  affirmAge,
  ageAffirmed,
  BURNER_KEY,
  BURNER_PREVIOUS_KEY,
  decodeSecret,
  ensureBurner,
  exportBurner,
  importBurner,
  type KeyStore,
  needsAge,
  openKeyStore,
} from '../lib/burner'

function memoryStore(): KeyStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

/** A store whose 18+ self-declaration is already ticked. */
function affirmedStore() {
  const store = memoryStore()
  affirmAge(store)
  return store
}

const blockedStorage = (): KeyStore => {
  throw new DOMException('The operation is insecure.', 'SecurityError')
}

describe('burner wallet', () => {
  it('creates a keypair once and returns the same one afterwards', () => {
    const store = affirmedStore()
    const a = ensureBurner(store)
    const b = ensureBurner(store)
    expect(b.publicKey.equals(a.publicKey)).toBe(true)
    expect(store.map.get(BURNER_KEY)).toBe(bs58.encode(a.secretKey))
  })

  it('exports base58 that imports back to the same key', () => {
    const kp = Keypair.generate()
    expect(decodeSecret(exportBurner(kp)).publicKey.equals(kp.publicKey)).toBe(true)
  })

  it('imports a solana-keygen JSON byte array', () => {
    const kp = Keypair.generate()
    const json = JSON.stringify(Array.from(kp.secretKey))
    expect(decodeSecret(` ${json}\n`).publicKey.equals(kp.publicKey)).toBe(true)
  })

  it('keeps the replaced key under the previous slot', () => {
    const store = affirmedStore()
    const old = ensureBurner(store)
    const next = Keypair.generate()
    importBurner(store, exportBurner(next))
    expect(store.map.get(BURNER_PREVIOUS_KEY)).toBe(exportBurner(old))
    expect(ensureBurner(store).publicKey.equals(next.publicKey)).toBe(true)
  })

  it('re-importing the current key does not overwrite the previous slot', () => {
    const store = affirmedStore()
    const kp = ensureBurner(store)
    importBurner(store, exportBurner(kp))
    expect(store.map.has(BURNER_PREVIOUS_KEY)).toBe(false)
  })

  it('rejects text that is not a key, a short key and a mismatched key', () => {
    expect(() => decodeSecret('not base58 0OIl')).toThrow(/base58 secret key/)
    expect(() => decodeSecret(bs58.encode(new Uint8Array(32)))).toThrow(/64 bytes; this one is 32/)
    const forged = new Uint8Array(64).fill(7)
    expect(() => decodeSecret(bs58.encode(forged))).toThrow(/does not match/)
  })

  it('moves an unreadable stored value aside instead of overwriting it', () => {
    const store = affirmedStore()
    store.setItem(BURNER_KEY, 'garbage')
    const kp = ensureBurner(store, 1_700_000_000_000)
    expect(store.map.get(`${BURNER_KEY}.unreadable.1700000000000`)).toBe('garbage')
    expect(store.map.get(BURNER_KEY)).toBe(exportBurner(kp))
  })

  it('falls back to a tab-only store when localStorage is blocked or full', () => {
    const blocked = openKeyStore(blockedStorage)
    expect(blocked.ephemeral).toBe(true)
    affirmAge(blocked.store)
    const kp = ensureBurner(blocked.store)
    expect(ensureBurner(blocked.store).publicKey.equals(kp.publicKey)).toBe(true)

    const full = memoryStore()
    full.setItem = () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    }
    expect(openKeyStore(() => full).ephemeral).toBe(true)

    const ok = memoryStore()
    expect(openKeyStore(() => ok)).toEqual({ store: ok, ephemeral: false })
    expect(ok.map.size).toBe(0)
  })
})

describe('18+ self-declaration (R1)', () => {
  it('does not create a burner before the box is ticked, and stores nothing', () => {
    const store = memoryStore()
    expect(() => ensureBurner(store)).toThrow(AgeRequired)
    expect(store.map.size).toBe(0)
  })

  it('does not import before the box is ticked, and stores nothing', () => {
    const store = memoryStore()
    const kp = Keypair.generate()
    expect(() => importBurner(store, exportBurner(kp))).toThrow(AgeRequired)
    expect(store.map.size).toBe(0)
  })

  it('still reports a bad secret first when the box is not ticked', () => {
    const store = memoryStore()
    expect(() => importBurner(store, 'nope 0OIl')).toThrow(/base58 secret key/)
    expect(() => importBurner(store, 'nope 0OIl')).not.toThrow(AgeRequired)
    expect(store.map.size).toBe(0)
  })

  it('returns an existing burner without the flag, and asks once via needsAge', () => {
    const store = memoryStore()
    const kp = Keypair.generate()
    store.setItem(BURNER_KEY, exportBurner(kp))
    expect(ensureBurner(store).publicKey.equals(kp.publicKey)).toBe(true)
    expect(needsAge(store)).toBe(true)
    affirmAge(store)
    expect(needsAge(store)).toBe(false)
  })

  it('needs no age question when there is no burner yet', () => {
    expect(needsAge(memoryStore())).toBe(false)
  })

  it('affirming, then creating and importing, works', () => {
    const store = memoryStore()
    affirmAge(store, 1_700_000_000_000)
    expect(JSON.parse(store.map.get(AGE_KEY) ?? '')).toEqual({ affirmedAt: 1_700_000_000_000 })
    expect(ageAffirmed(store)).toBe(true)
    ensureBurner(store)
    const next = Keypair.generate()
    expect(importBurner(store, exportBurner(next)).publicKey.equals(next.publicKey)).toBe(true)
  })

  it('counts a missing, corrupt or foreign flag value as not affirmed', () => {
    for (const raw of [undefined, '{', 'null', '"x"', '{}', '{"affirmedAt":"now"}', '[1]']) {
      const store = memoryStore()
      if (raw !== undefined) store.setItem(AGE_KEY, raw)
      expect(ageAffirmed(store)).toBe(false)
      expect(() => ensureBurner(store)).toThrow(AgeRequired)
    }
  })

  it('treats a throwing store as not affirmed', () => {
    const store: KeyStore = {
      getItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
      setItem: () => {},
      removeItem: () => {},
    }
    expect(ageAffirmed(store)).toBe(false)
  })

  it('keeps the flag in memory only when storage is blocked', () => {
    const blocked = openKeyStore(blockedStorage)
    expect(blocked.ephemeral).toBe(true)
    affirmAge(blocked.store)
    expect(ageAffirmed(blocked.store)).toBe(true)
    // A fresh open after a reload starts over and asks again.
    const reopened = openKeyStore(blockedStorage)
    expect(ageAffirmed(reopened.store)).toBe(false)
  })
})
