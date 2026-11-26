import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { afterGate, createAgeGate, gateClosesOnSync, loadWallet, walletGate } from '../lib/age-gate'
import {
  AGE_KEY,
  affirmAge,
  ageAffirmed,
  BURNER_KEY,
  exportBurner,
  type KeyStore,
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

describe('loadWallet (R5: no prompt on load)', () => {
  it('creates and writes nothing on a first visit', () => {
    const store = memoryStore()
    expect(loadWallet(store)).toBeNull()
    expect(store.map.size).toBe(0)
  })

  it('loads a stored burner, asked or not, and asks nothing', () => {
    const kp = Keypair.generate()
    const store = memoryStore()
    store.setItem(BURNER_KEY, exportBurner(kp))
    expect(loadWallet(store)?.publicKey.toBase58()).toBe(kp.publicKey.toBase58())
    expect(store.getItem(AGE_KEY)).toBeNull()
  })

  it('gives a device that ticked the box before its burner back', () => {
    const store = memoryStore()
    affirmAge(store)
    expect(loadWallet(store)).not.toBeNull()
    expect(store.getItem(BURNER_KEY)).not.toBeNull()
  })

  it('has no burner when storage refuses the new one', () => {
    const map = new Map<string, string>([[AGE_KEY, JSON.stringify({ affirmedAt: 1 })]])
    const refusing: KeyStore = {
      getItem: (k) => map.get(k) ?? null,
      setItem: () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError')
      },
      removeItem: () => {},
    }
    expect(loadWallet(refusing)).toBeNull()
  })
})

describe('createAgeGate (R5: ask at the first action, nothing sent before the tick)', () => {
  const sends = () => {
    const calls: string[] = []
    return { calls, send: (kp: Keypair) => void calls.push(kp.publicKey.toBase58()) }
  }

  it.each(['trade', 'faucet', 'claim'] as const)(
    'asks on a first %s with no burner, and creates and sends nothing',
    (action) => {
      const store = memoryStore()
      const gate = createAgeGate()
      const s = sends()
      expect(gate.request(store, loadWallet(store), s.send, action)).toEqual({ ask: true })
      expect(gate.waiting()).toBe(true)
      expect(s.calls).toEqual([])
      expect(store.map.size).toBe(0)
    },
  )

  it('asks a stored burner that was never asked before it sends', () => {
    const store = memoryStore()
    store.setItem(BURNER_KEY, exportBurner(Keypair.generate()))
    const gate = createAgeGate()
    const s = sends()
    expect(gate.request(store, loadWallet(store), s.send, 'trade')).toEqual({ ask: true })
    expect(s.calls).toEqual([])
    expect(store.getItem(AGE_KEY)).toBeNull()
  })

  it('sends at once once the box was ticked and the burner exists', () => {
    const store = memoryStore()
    affirmAge(store)
    const kp = loadWallet(store)
    const gate = createAgeGate()
    const s = sends()
    expect(gate.request(store, kp, s.send, 'trade')).toMatchObject({ ask: false, created: false })
    expect(s.calls).toEqual([kp?.publicKey.toBase58()])
  })

  it('a cancel drops the waiting action: nothing is created or sent', () => {
    const store = memoryStore()
    const gate = createAgeGate()
    const s = sends()
    gate.request(store, null, s.send, 'faucet')
    gate.cancel()
    expect(gate.waiting()).toBe(false)
    expect(s.calls).toEqual([])
    expect(store.map.size).toBe(0)
  })

  it('the dialog’s tick creates the burner and continues a faucet request, not a trade', () => {
    const store = memoryStore()
    const gate = createAgeGate()
    const faucet = sends()
    gate.request(store, null, faucet.send, 'faucet')
    const r = gate.confirm(store)
    expect(r.created).toBe(true)
    expect(ageAffirmed(store)).toBe(true)
    expect(faucet.calls).toEqual([r.keypair.publicKey.toBase58()])

    const other = memoryStore()
    const trade = sends()
    gate.request(other, null, trade.send, 'trade')
    gate.confirm(other)
    expect(trade.calls).toEqual([])
    expect(gate.waiting()).toBe(false)
  })

  it('the crown’s inline tick sets the flag, creates the burner and funds it, with no dialog', () => {
    const store = memoryStore()
    const gate = createAgeGate()
    const s = sends()
    const out = gate.request(store, null, s.send, 'faucet', true)
    expect(out.ask).toBe(false)
    expect(ageAffirmed(store)).toBe(true)
    expect(store.getItem(BURNER_KEY)).not.toBeNull()
    expect(s.calls).toHaveLength(1)
    expect(gate.waiting()).toBe(false)
  })

  it('an inline tick on a stored burner sends the trade it was ticked for', () => {
    const kp = Keypair.generate()
    const store = memoryStore()
    store.setItem(BURNER_KEY, exportBurner(kp))
    const gate = createAgeGate()
    const s = sends()
    expect(gate.request(store, kp, s.send, 'trade', true)).toMatchObject({ created: false })
    expect(s.calls).toEqual([kp.publicKey.toBase58()])
  })

  it('a failed save keeps the dialog’s action waiting for a second Continue', () => {
    const store = memoryStore()
    const gate = createAgeGate()
    const s = sends()
    gate.request(store, null, s.send, 'faucet')
    const refusing: KeyStore = { ...store, setItem: () => void raise() }
    expect(() => gate.confirm(refusing)).toThrow()
    expect(gate.waiting()).toBe(true)
    gate.confirm(store)
    expect(s.calls).toHaveLength(1)
  })
})

function raise(): never {
  throw new DOMException('Quota exceeded', 'QuotaExceededError')
}
