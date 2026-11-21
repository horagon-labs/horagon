import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { walletGate } from '../lib/age-gate'
import { AGE_KEY, affirmAge, BURNER_KEY, exportBurner, type KeyStore } from '../lib/burner'

function memoryStore(): KeyStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('walletGate (R1)', () => {
  it('asks before creating the first burner', () => {
    expect(walletGate(memoryStore())).toBe('ask-new')
  })

  it('asks an existing burner without the flag once, before it sends', () => {
    const store = memoryStore()
    store.setItem(BURNER_KEY, exportBurner(Keypair.generate()))
    expect(walletGate(store)).toBe('ask-existing')
  })

  it('is ready once the box was ticked, with or without a burner', () => {
    const store = memoryStore()
    affirmAge(store)
    expect(walletGate(store)).toBe('ready')
    store.setItem(BURNER_KEY, exportBurner(Keypair.generate()))
    expect(walletGate(store)).toBe('ready')
  })

  it('treats an unreadable stored value as no burner: the next create needs the box', () => {
    const store = memoryStore()
    store.setItem(BURNER_KEY, 'garbage')
    expect(walletGate(store)).toBe('ask-new')
    store.setItem(AGE_KEY, '{')
    expect(walletGate(store)).toBe('ask-new')
  })

  it('never writes', () => {
    const store = memoryStore()
    walletGate(store)
    expect(store.map.size).toBe(0)
    store.setItem(BURNER_KEY, 'garbage')
    walletGate(store)
    store.setItem(BURNER_KEY, exportBurner(Keypair.generate()))
    const before = new Map(store.map)
    walletGate(store)
    expect(store.map).toEqual(before)
  })

  it('asks for a new burner when storage cannot be read', () => {
    const refusing: KeyStore = {
      getItem: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      },
      setItem: () => {},
      removeItem: () => {},
    }
    expect(walletGate(refusing)).toBe('ask-new')
  })
})
