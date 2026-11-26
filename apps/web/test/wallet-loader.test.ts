// The wallet on a page load (R5c, lib/wallet-loader.ts): the stored burner is read without the key
// code, which loads with the first action, once. The rules that action runs are wallet-core's,
// tested in wallet-core.test.ts; here they are a fake core, then the real one end to end.
import { Keypair } from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import { AGE_KEY, affirmAge, BURNER_KEY, exportBurner, type KeyStore } from '../lib/burner'
import type { WalletCore, WalletUi } from '../lib/wallet-core'
import type { CoreModule, LoaderUi } from '../lib/wallet-loader'
import { walletLoader } from '../lib/wallet-loader'

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
  return {
    setBurner: vi.fn<LoaderUi['setBurner']>(),
    setAgeOk: vi.fn<LoaderUi['setAgeOk']>(),
    openGate: vi.fn<LoaderUi['openGate']>(),
    closeGate: vi.fn<LoaderUi['closeGate']>(),
    created: vi.fn<LoaderUi['created']>(),
  }
}

/** A fake core module: records what the loader hands it, and the order of the actions. */
function fakeCore() {
  const order: string[] = []
  let given: WalletUi | undefined
  const core = {
    open: vi.fn(),
    sync: vi.fn(() => void order.push('sync')),
    ask: vi.fn(() => void order.push('ask')),
    confirm: vi.fn(() => void order.push('confirm')),
    cancel: vi.fn(() => void order.push('cancel')),
    withAge: vi.fn((_send: unknown, action: string) => void order.push(`withAge:${action}`)),
    importKey: vi.fn(() => {
      order.push('importKey')
      return true
    }),
  }
  const module: CoreModule = {
    walletCore: (u) => {
      given = u
      return core as unknown as WalletCore
    },
  }
  const load = vi.fn(() => Promise.resolve(module))
  return { core, load, order, ui: () => given }
}

describe('walletLoader mount (R5c: a page load reads only and loads no key code)', () => {
  it('a stored burner shows its address, with no core load, no dialog and no write', () => {
    const kp = Keypair.generate()
    const { s, writes } = store({ [BURNER_KEY]: exportBurner(kp) })
    const u = ui()
    const f = fakeCore()
    const w = walletLoader(u, f.load)
    const o = w.mount(() => s)
    expect(o.ephemeral).toBe(false)
    expect(f.load).not.toHaveBeenCalled()
    expect(w.loaded()).toBe(false)
    expect(u.openGate).not.toHaveBeenCalled()
    expect(writes).toEqual([])
    expect(u.setBurner.mock.lastCall?.[0]?.address).toBe(kp.publicKey.toBase58())
    expect(u.setAgeOk).toHaveBeenLastCalledWith(false)
  })

  it('a first visit has no burner and writes nothing; a ticked device reads its tick', () => {
    const first = store()
    const u = ui()
    walletLoader(u, fakeCore().load).mount(() => first.s)
    expect(u.setBurner).toHaveBeenLastCalledWith(null)
    expect(first.writes).toEqual([])
    expect(first.map.size).toBe(0)

    const ticked = store()
    affirmAge(ticked.s)
    ticked.writes.length = 0
    const v = ui()
    walletLoader(v, fakeCore().load).mount(() => ticked.s)
    expect(v.setAgeOk).toHaveBeenLastCalledWith(true)
    // Its missing burner comes back with the first action (the core's loadWallet), not here.
    expect(v.setBurner).toHaveBeenLastCalledWith(null)
    expect(ticked.writes).toEqual([])
  })

  it('a blocked browser still mounts, in memory', () => {
    const u = ui()
    const o = walletLoader(u, fakeCore().load).mount(() => {
      throw new Error('SecurityError')
    })
    expect(o.ephemeral).toBe(true)
    expect(u.setBurner).toHaveBeenLastCalledWith(null)
  })

  it('does nothing before the mount: no load, nothing sent, Import refused', async () => {
    const f = fakeCore()
    const w = walletLoader(ui(), f.load)
    const send = vi.fn()
    await expect(w.withAge(send, 'faucet', true)).resolves.toBeUndefined()
    await expect(w.ask()).resolves.toBeUndefined()
    await expect(w.importKey('x', true)).resolves.toBe(false)
    w.sync()
    w.confirm()
    w.cancel()
    expect(f.load).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})

describe('walletLoader actions: the core loads with the first one, once', () => {
  it('loads once, opens the core on the mounted store, and runs the actions in order', async () => {
    const { s } = store()
    const u = ui()
    const f = fakeCore()
    const w = walletLoader(u, f.load)
    const o = w.mount(() => s)
    const send = vi.fn()
    await Promise.all([
      w.withAge(send, 'faucet', true),
      w.ask(),
      w.withAge(send, 'trade'),
      w.importKey('key', false),
    ])
    expect(f.load).toHaveBeenCalledTimes(1)
    expect(f.core.open).toHaveBeenCalledTimes(1)
    expect(f.core.open).toHaveBeenCalledWith(o)
    expect(f.order).toEqual(['withAge:faucet', 'ask', 'withAge:trade', 'importKey'])
    expect(f.core.withAge.mock.calls[0]).toEqual([send, 'faucet', true])
    expect(w.loaded()).toBe(true)
    await w.withAge(send)
    expect(f.load).toHaveBeenCalledTimes(1)
    expect(f.core.withAge.mock.lastCall).toEqual([send, 'trade', false])
  })

  it('hands the core the provider’s UI, with the keypair shown as an address', async () => {
    const { s } = store()
    const u = ui()
    const f = fakeCore()
    const w = walletLoader(u, f.load)
    w.mount(() => s)
    await w.ask()
    const given = f.ui()
    expect(given?.openGate).toBe(u.openGate)
    expect(given?.closeGate).toBe(u.closeGate)
    expect(given?.created).toBe(u.created)
    const kp = Keypair.generate()
    given?.setKeypair(kp)
    expect(u.setBurner).toHaveBeenLastCalledWith({
      address: kp.publicKey.toBase58(),
      secretKey: kp.secretKey,
    })
    given?.setKeypair(null)
    expect(u.setBurner).toHaveBeenLastCalledWith(null)
  })

  it('a load that fails rejects the action that asked, and the next action tries again', async () => {
    const { s } = store()
    const f = fakeCore()
    const module = await f.load()
    f.load.mockClear()
    const load = vi
      .fn<() => Promise<CoreModule>>()
      .mockRejectedValueOnce(new Error('ChunkLoadError'))
      .mockResolvedValue(module)
    const w = walletLoader(ui(), load)
    w.mount(() => s)
    const send = vi.fn()
    await expect(w.withAge(send, 'faucet', true)).rejects.toThrow('ChunkLoadError')
    expect(f.core.withAge).not.toHaveBeenCalled()
    expect(w.loaded()).toBe(false)
    await w.withAge(send, 'faucet', true)
    expect(load).toHaveBeenCalledTimes(2)
    expect(f.core.withAge).toHaveBeenCalledTimes(1)
  })

  it('confirm and cancel wait for the core: only the core opens the dialog they answer', async () => {
    const { s } = store()
    const f = fakeCore()
    const w = walletLoader(ui(), f.load)
    w.mount(() => s)
    w.confirm()
    w.cancel()
    expect(f.order).toEqual([])
    await w.ask()
    w.confirm()
    w.cancel()
    expect(f.order).toEqual(['ask', 'confirm', 'cancel'])
  })

  it('sync reads the store again before the load, and hands over to the core after it', async () => {
    const { s, map } = store()
    const u = ui()
    const f = fakeCore()
    const w = walletLoader(u, f.load)
    w.mount(() => s)
    const kp = Keypair.generate()
    map.set(BURNER_KEY, exportBurner(kp))
    map.set(AGE_KEY, JSON.stringify({ affirmedAt: 1 }))
    w.sync()
    expect(u.setBurner.mock.lastCall?.[0]?.address).toBe(kp.publicKey.toBase58())
    expect(u.setAgeOk).toHaveBeenLastCalledWith(true)
    expect(f.core.sync).not.toHaveBeenCalled()
    await w.ask()
    w.sync()
    expect(f.core.sync).toHaveBeenCalledTimes(1)
  })
})

describe('walletLoader with the real core (lib/wallet-core.ts through its dynamic import)', () => {
  it('a first visit, then the crown’s inline tick: the burner is created and the send runs', async () => {
    const { s, writes } = store()
    const u = ui()
    const w = walletLoader(u)
    w.mount(() => s)
    expect(writes).toEqual([])
    const sent: string[] = []
    await w.withAge((kp) => void sent.push(kp.publicKey.toBase58()), 'faucet', true)
    expect(w.loaded()).toBe(true)
    expect(writes).toContain(AGE_KEY)
    expect(writes).toContain(BURNER_KEY)
    const address = u.setBurner.mock.lastCall?.[0]?.address
    expect(address).toBeTruthy()
    expect(sent).toEqual([address])
    expect(u.setAgeOk).toHaveBeenLastCalledWith(true)
    expect(u.openGate).not.toHaveBeenCalled()
  })

  it('no tick: the dialog opens and nothing is created or sent until Continue', async () => {
    const { s, writes } = store()
    const u = ui()
    const w = walletLoader(u)
    w.mount(() => s)
    const send = vi.fn()
    await w.withAge(send, 'faucet')
    expect(u.openGate).toHaveBeenCalledTimes(1)
    expect(writes).toEqual([])
    expect(send).not.toHaveBeenCalled()
    w.confirm()
    expect(u.created).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('"Set up wallet" on a device that ticked the box before: its burner comes back, no 2nd ask', async () => {
    const { s, writes } = store()
    affirmAge(s)
    writes.length = 0
    const u = ui()
    const w = walletLoader(u)
    w.mount(() => s)
    expect(u.setBurner).toHaveBeenLastCalledWith(null)
    expect(writes).toEqual([])
    await w.ask()
    expect(writes).toEqual([BURNER_KEY])
    expect(u.setBurner.mock.lastCall?.[0]?.address).toBeTruthy()
    expect(u.openGate).not.toHaveBeenCalled()
    expect(u.created).toHaveBeenCalledTimes(1)
  })

  it('"Set up wallet" on a first visit opens the dialog and creates nothing', async () => {
    const { s, writes } = store()
    const u = ui()
    const w = walletLoader(u)
    w.mount(() => s)
    await w.ask()
    expect(u.openGate).toHaveBeenCalledTimes(1)
    expect(u.created).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('a stored burner keeps its address once the core loads', async () => {
    const kp = Keypair.generate()
    const { s } = store({ [BURNER_KEY]: exportBurner(kp) })
    affirmAge(s)
    const u = ui()
    const w = walletLoader(u)
    w.mount(() => s)
    const sent: string[] = []
    await w.withAge((k) => void sent.push(k.publicKey.toBase58()))
    expect(sent).toEqual([kp.publicKey.toBase58()])
    expect(u.setBurner.mock.lastCall?.[0]?.address).toBe(kp.publicKey.toBase58())
  })

  it('Import rejects bad text with the words for it, and replaces nothing', async () => {
    const kp = Keypair.generate()
    const { s, map } = store({ [BURNER_KEY]: exportBurner(kp) })
    const w = walletLoader(ui())
    w.mount(() => s)
    await expect(w.importKey('not a key 0OIl', true)).rejects.toThrow(
      'Paste a base58 secret key or a JSON array of 64 numbers.',
    )
    expect(map.get(BURNER_KEY)).toBe(exportBurner(kp))
  })
})
