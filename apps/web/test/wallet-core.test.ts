// WalletProvider's rules (lib/wallet-core.ts), tested in Node: the repo has no DOM test
// environment (happy-dom and jsdom are only optional peers of vitest in the lockfile), so the
// provider's effect and callbacks run through this core, and the core is what is tested here.
import { Keypair } from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import { AGE_KEY, affirmAge, BURNER_KEY, exportBurner, type KeyStore } from '../lib/burner'
import { SAVE_FAILED, type WalletUi, walletCore } from '../lib/wallet-core'

const PROBE = `${BURNER_KEY}.probe`

/** A store that records every write, the storage probe of openKeyStore aside. */
function store(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  const writes: string[] = []
  const s: KeyStore = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      if (k !== PROBE) writes.push(k)
      map.set(k, v)
    },
    removeItem: (k) => void map.delete(k),
  }
  return { s, map, writes }
}

function ui() {
  const u = {
    setKeypair: vi.fn<WalletUi['setKeypair']>(),
    setAgeOk: vi.fn<WalletUi['setAgeOk']>(),
    openGate: vi.fn<WalletUi['openGate']>(),
    closeGate: vi.fn<WalletUi['closeGate']>(),
    created: vi.fn<WalletUi['created']>(),
  }
  return u
}

const sends = () => {
  const calls: string[] = []
  return { calls, send: (kp: Keypair) => void calls.push(kp.publicKey.toBase58()) }
}

describe('WalletProvider mount (R5: no dialog and no store write on a page load)', () => {
  it('a first visit opens no dialog, writes nothing and has no burner', () => {
    const { s, map, writes } = store()
    const u = ui()
    const o = walletCore(u).mount(() => s)
    expect(o.ephemeral).toBe(false)
    expect(u.openGate).not.toHaveBeenCalled()
    expect(writes).toEqual([])
    expect(map.size).toBe(0)
    expect(u.setKeypair).toHaveBeenLastCalledWith(null)
    expect(u.setAgeOk).toHaveBeenLastCalledWith(false)
  })

  it('loads a stored burner never asked, asking nothing and writing no flag', () => {
    const kp = Keypair.generate()
    const { s, writes } = store({ [BURNER_KEY]: exportBurner(kp) })
    const u = ui()
    walletCore(u).mount(() => s)
    expect(u.openGate).not.toHaveBeenCalled()
    expect(writes).toEqual([])
    expect(s.getItem(AGE_KEY)).toBeNull()
    expect(u.setKeypair.mock.lastCall?.[0]?.publicKey.toBase58()).toBe(kp.publicKey.toBase58())
    expect(u.setAgeOk).toHaveBeenLastCalledWith(false)
  })

  it('a returning device gets its wallet and its tick back, still with no dialog', () => {
    const kp = Keypair.generate()
    const { s } = store({ [BURNER_KEY]: exportBurner(kp) })
    affirmAge(s)
    const u = ui()
    walletCore(u).mount(() => s)
    expect(u.openGate).not.toHaveBeenCalled()
    expect(u.setAgeOk).toHaveBeenLastCalledWith(true)
    expect(u.setKeypair.mock.lastCall?.[0]?.publicKey.toBase58()).toBe(kp.publicKey.toBase58())
  })

  it('does nothing before the mount (the server render, the first browser render)', () => {
    const u = ui()
    const core = walletCore(u)
    const s = sends()
    core.withAge(s.send, 'faucet', true)
    core.confirm()
    expect(core.importKey('x', true)).toBe(false)
    expect(s.calls).toEqual([])
    expect(u.openGate).not.toHaveBeenCalled()
  })
})

describe('withAge (R5)', () => {
  it('counts only a strict true as the inline tick: a click event never passes for it', () => {
    for (const notATick of [{ type: 'click' }, 'yes', 1, undefined]) {
      const { s, map, writes } = store()
      const u = ui()
      const core = walletCore(u)
      core.mount(() => s)
      const sent = sends()
      core.withAge(sent.send, 'faucet', notATick)
      expect(u.openGate).toHaveBeenCalledWith()
      expect(sent.calls).toEqual([])
      expect(writes).toEqual([])
      expect(map.size).toBe(0)
    }
  })

  it('an inline tick sets the flag, creates the burner and sends, with no dialog', () => {
    const { s } = store()
    const u = ui()
    const core = walletCore(u)
    core.mount(() => s)
    const sent = sends()
    core.withAge(sent.send, 'faucet', true)
    expect(u.openGate).not.toHaveBeenCalled()
    expect(s.getItem(AGE_KEY)).not.toBeNull()
    expect(s.getItem(BURNER_KEY)).not.toBeNull()
    expect(sent.calls).toHaveLength(1)
    expect(u.setAgeOk).toHaveBeenLastCalledWith(true)
    expect(u.created).not.toHaveBeenCalled()
  })

  it('lets an error a send throws reach the caller, never as a refused save (finding 11)', () => {
    const { s } = store()
    affirmAge(s)
    const u = ui()
    const core = walletCore(u)
    core.mount(() => s)
    const boom = () => {
      throw new Error('send broke')
    }
    expect(() => core.withAge(boom, 'trade')).toThrow('send broke')
    expect(() => core.withAge(boom, 'faucet', true)).toThrow('send broke')
    expect(u.openGate).not.toHaveBeenCalled()
  })

  it('says a refused inline save in the dialog, and sends nothing', () => {
    const { s } = store()
    const u = ui()
    const core = walletCore(u)
    core.mount(() => ({
      ...s,
      setItem: (k: string, v: string) => {
        if (k !== PROBE) throw new DOMException('Quota exceeded', 'QuotaExceededError')
        s.setItem(k, v)
      },
    }))
    const sent = sends()
    core.withAge(sent.send, 'faucet', true)
    expect(u.openGate).toHaveBeenCalledWith(SAVE_FAILED)
    expect(sent.calls).toEqual([])
  })
})

describe('"Set up wallet" and the dialog (askOnly)', () => {
  it('opens the dialog with nothing waiting, and its tick creates an empty wallet', () => {
    const { s } = store()
    const u = ui()
    const core = walletCore(u)
    core.mount(() => s)
    core.ask()
    expect(u.openGate).toHaveBeenCalledWith()
    expect(core.gate.waiting()).toBe(false)
    expect(s.getItem(BURNER_KEY)).toBeNull()
    core.confirm()
    expect(s.getItem(BURNER_KEY)).not.toBeNull()
    expect(u.created).toHaveBeenCalledTimes(1)
    expect(u.closeGate).toHaveBeenCalled()
  })

  it('drops an action that was waiting: set-up sends nothing', () => {
    const { s } = store()
    const u = ui()
    const core = walletCore(u)
    core.mount(() => s)
    const sent = sends()
    core.withAge(sent.send, 'faucet')
    expect(core.gate.waiting()).toBe(true)
    core.ask()
    expect(core.gate.waiting()).toBe(false)
    core.confirm()
    expect(sent.calls).toEqual([])
  })

  it('the dialog’s tick continues a waiting faucet request; Cancel drops it', () => {
    const { s } = store()
    const u = ui()
    const core = walletCore(u)
    core.mount(() => s)
    const sent = sends()
    core.withAge(sent.send, 'faucet')
    core.cancel()
    expect(u.closeGate).toHaveBeenCalled()
    core.confirm()
    expect(sent.calls).toEqual([])
    const again = store()
    const core2 = walletCore(ui())
    core2.mount(() => again.s)
    core2.withAge(sent.send, 'faucet')
    core2.confirm()
    expect(sent.calls).toHaveLength(1)
  })

  it('keeps the action waiting when the dialog’s save is refused', () => {
    const { s } = store()
    let refuse = true
    const u = ui()
    const core = walletCore(u)
    core.mount(() => ({
      ...s,
      setItem: (k: string, v: string) => {
        if (refuse && k !== PROBE) throw new DOMException('Quota exceeded', 'QuotaExceededError')
        s.setItem(k, v)
      },
    }))
    const sent = sends()
    core.withAge(sent.send, 'faucet')
    core.confirm()
    expect(u.openGate).toHaveBeenLastCalledWith(SAVE_FAILED)
    expect(core.gate.waiting()).toBe(true)
    refuse = false
    core.confirm()
    expect(sent.calls).toHaveLength(1)
  })
})

describe('sync and import', () => {
  it('follows another tab, and closes the dialog once that tab confirmed', () => {
    const { s } = store()
    const u = ui()
    const core = walletCore(u)
    core.mount(() => s)
    core.ask()
    s.setItem(BURNER_KEY, exportBurner(Keypair.generate()))
    affirmAge(s)
    core.sync()
    expect(u.closeGate).toHaveBeenCalled()
    expect(u.setAgeOk).toHaveBeenLastCalledWith(true)
  })

  it('asks instead of throwing when an import comes without the box', () => {
    const { s } = store()
    const u = ui()
    const core = walletCore(u)
    core.mount(() => s)
    const text = exportBurner(Keypair.generate())
    expect(core.importKey(text, false)).toBe(false)
    expect(u.openGate).toHaveBeenCalledWith()
    expect(core.importKey(text, true)).toBe(true)
    expect(s.getItem(AGE_KEY)).not.toBeNull()
  })
})
