import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { afterGate, gateClosesOnSync, walletGate } from '../lib/age-gate'
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

describe('afterGate (fix M3)', () => {
  it('continues every action when the burner already existed', () => {
    for (const action of ['trade', 'claim', 'faucet'] as const) {
      expect(afterGate(action, false)).toBe('continue')
    }
  })

  it('on a wallet the gate just created, continues only a faucet request', () => {
    expect(afterGate('faucet', true)).toBe('continue')
    expect(afterGate('trade', true)).toBe('drop')
    expect(afterGate('claim', true)).toBe('drop')
  })
})

describe('gateClosesOnSync (fix M4)', () => {
  const readyStore = () => {
    const store = memoryStore()
    affirmAge(store)
    store.setItem(BURNER_KEY, exportBurner(Keypair.generate()))
    return store
  }

  it('closes when another tab stored a burner and ticked the box, with nothing pending', () => {
    expect(gateClosesOnSync(readyStore(), false)).toBe(true)
  })

  it('stays open while an action waits for this tab to tick the box', () => {
    expect(gateClosesOnSync(readyStore(), true)).toBe(false)
  })

  it('stays open without a burner or without the flag', () => {
    const noBurner = memoryStore()
    affirmAge(noBurner)
    expect(gateClosesOnSync(noBurner, false)).toBe(false)
    const noFlag = memoryStore()
    noFlag.setItem(BURNER_KEY, exportBurner(Keypair.generate()))
    expect(gateClosesOnSync(noFlag, false)).toBe(false)
    const unreadable = memoryStore()
    affirmAge(unreadable)
    unreadable.setItem(BURNER_KEY, 'garbage')
    expect(gateClosesOnSync(unreadable, false)).toBe(false)
  })
})
