// The page-load side of the wallet (R5c): the stored key's address without web3.js. Each address
// here is checked against web3.js's own Keypair and PublicKey, which these tests import and the
// page does not.
import { Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { describe, expect, it } from 'vitest'
import { decodeSecret, exportBurner, secretBytes } from '../lib/burner'
import {
  AGE_KEY,
  addressOf,
  BURNER_KEY,
  exportSecret,
  type KeyStore,
  keyBytes,
  readBurner,
} from '../lib/key-store'

/** A store that records every write. */
function store(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  const writes: string[] = []
  const s: KeyStore = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      writes.push(k)
      map.set(k, v)
    },
    removeItem: (k) => {
      writes.push(`-${k}`)
      map.delete(k)
    },
  }
  return { s, writes }
}

/** Seeds whose public keys cover the edge of base58: leading zero bytes, all-ones, a ramp. */
const SEEDS = [
  new Uint8Array(32),
  new Uint8Array(32).fill(0xff),
  Uint8Array.from({ length: 32 }, (_, i) => i),
  Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff),
]

describe('addressOf: the address web3.js gives, from the key bytes alone (R5c)', () => {
  it('matches Keypair.publicKey.toBase58() for 300 generated keys and fixed seeds', () => {
    const keys = [
      ...Array.from({ length: 300 }, () => Keypair.generate()),
      ...SEEDS.map((seed) => Keypair.fromSeed(seed)),
    ]
    for (const kp of keys) {
      expect(addressOf(kp.secretKey)).toBe(kp.publicKey.toBase58())
    }
  })

  it('matches PublicKey.toBase58() for public halves with leading zero bytes', () => {
    for (let zeros = 0; zeros <= 32; zeros++) {
      const pub = Uint8Array.from({ length: 32 }, (_, i) => (i < zeros ? 0 : (i * 53 + 7) & 0xff))
      const secret = new Uint8Array(64)
      secret.fill(9, 0, 32)
      secret.set(pub, 32)
      expect(addressOf(secret), `zeros ${zeros}`).toBe(new PublicKey(pub).toBase58())
    }
  })

  it('reads the public half only, and refuses anything but 64 bytes', () => {
    const kp = Keypair.generate()
    const seedChanged = Uint8Array.from(kp.secretKey)
    seedChanged[0] = (seedChanged[0] as number) ^ 1
    expect(addressOf(seedChanged)).toBe(kp.publicKey.toBase58())
    expect(() => addressOf(new Uint8Array(32))).toThrow(RangeError)
    expect(() => addressOf(new Uint8Array(65))).toThrow(RangeError)
  })

  it('exportSecret is the base58 text Export shows, as exportBurner gave it', () => {
    const kp = Keypair.generate()
    expect(exportSecret(kp.secretKey)).toBe(exportBurner(kp))
    expect(exportSecret(kp.secretKey)).toBe(bs58.encode(kp.secretKey))
  })
})

describe('keyBytes and secretBytes: the pasted or stored text', () => {
  it('takes base58 and a JSON byte array alike', () => {
    const kp = Keypair.generate()
    const json = JSON.stringify([...kp.secretKey])
    expect(keyBytes(` ${bs58.encode(kp.secretKey)}\n`)).toEqual(kp.secretKey)
    expect(keyBytes(json)).toEqual(kp.secretKey)
    expect(secretBytes(json)).toEqual(kp.secretKey)
  })

  it('keeps the words an import shows for a bad key', () => {
    expect(() => secretBytes('not base58 0OIl')).toThrow(
      'Paste a base58 secret key or a JSON array of 64 numbers.',
    )
    expect(() => secretBytes('[1, 2')).toThrow(
      'Paste a base58 secret key or a JSON array of 64 numbers.',
    )
    expect(() => secretBytes(bs58.encode(new Uint8Array(32).fill(1)))).toThrow(
      'A secret key is 64 bytes; this one is 32.',
    )
    const kp = Keypair.generate()
    const halves = Uint8Array.from(kp.secretKey)
    halves[40] = (halves[40] as number) ^ 1
    expect(() => decodeSecret(bs58.encode(halves))).toThrow(
      'This secret key does not match its public key.',
    )
  })
})

describe('readBurner: the stored burner on a page load, read only', () => {
  it('gives the address and the secret key of a stored burner, base58 or JSON', () => {
    const kp = Keypair.generate()
    for (const raw of [exportBurner(kp), JSON.stringify([...kp.secretKey])]) {
      const { s, writes } = store({ [BURNER_KEY]: raw })
      const b = readBurner(s)
      expect(b?.address).toBe(kp.publicKey.toBase58())
      expect(b?.secretKey).toEqual(kp.secretKey)
      expect(writes).toEqual([])
    }
  })

  it('is null for no burner, a value that does not decode, or the wrong length; never writes', () => {
    for (const raw of [undefined, '', 'not a key', '[1,2,3]', bs58.encode(new Uint8Array(63))]) {
      const { s, writes } = store(raw === undefined ? {} : { [BURNER_KEY]: raw })
      expect(readBurner(s), String(raw)).toBeNull()
      expect(writes).toEqual([])
    }
  })

  it('is null when storage cannot be read', () => {
    const broken: KeyStore = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('no writes')
      },
      removeItem: () => {
        throw new Error('no writes')
      },
    }
    expect(readBurner(broken)).toBeNull()
  })

  it('reads the burner key only: the 18+ flag stays as it was', () => {
    const kp = Keypair.generate()
    const { s } = store({ [BURNER_KEY]: exportBurner(kp) })
    readBurner(s)
    expect(s.getItem(AGE_KEY)).toBeNull()
  })
})
