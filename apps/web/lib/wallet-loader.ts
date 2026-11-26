// The wallet on a page load, without web3.js (R5c). WalletProvider reads the stored burner and the
// 18+ answer here (lib/key-store.ts: the address is the key's last 32 bytes in base58). The rules
// that create, import or send with a key (lib/wallet-core.ts, with lib/age-gate.ts, lib/burner.ts
// and web3.js) load with the first action that needs them, through a dynamic import(): Buy, the
// faucet, Claim all, "Set up wallet" and Import. A page load never loads them, never asks and
// writes nothing but openKeyStore's probe.
//
// Every 18+ rule stays in the core (R5): this file only decides when it loads, and hands each
// action to it unchanged, so nothing is created, imported, signed or sent before the box is
// ticked, there and only there.
import type { Keypair } from '@solana/web3.js'
import type { GateAction, Send } from './age-gate'
import {
  ageAffirmed,
  type KeyStore,
  openKeyStore,
  readBurner,
  type StoredBurner,
} from './key-store'
import type { Opened, WalletCore, WalletUi } from './wallet-core'

/** The provider's side: WalletUi, with the burner as the page shows it (no Keypair). */
export interface LoaderUi extends Omit<WalletUi, 'setKeypair'> {
  setBurner: (burner: StoredBurner | null) => void
}

/** What the dynamic import of lib/wallet-core.ts gives. */
export type CoreModule = { walletCore: (ui: WalletUi) => WalletCore }

const loadCore = (): Promise<CoreModule> => import('./wallet-core')

const shown = (kp: Keypair | null): StoredBurner | null =>
  kp === null ? null : { address: kp.publicKey.toBase58(), secretKey: kp.secretKey }

export function walletLoader(ui: LoaderUi, load: () => Promise<CoreModule> = loadCore) {
  let opened: Opened | null = null
  let core: WalletCore | null = null
  let loading: Promise<WalletCore> | null = null
  /** The burner on screen: read from the store, then the core's. */
  let current: StoredBurner | null = null
  const show = (b: StoredBurner | null): void => {
    current = b
    ui.setBurner(b)
  }

  const read = (o: Opened): void => {
    ui.setAgeOk(ageAffirmed(o.store))
    show(readBurner(o.store))
  }

  /**
   * The core, loaded once and handed the store this page opened. A load that fails is forgotten,
   * so the next action tries again; the action that asked gets the error.
   */
  function rules(o: Opened): Promise<WalletCore> {
    if (core) return Promise.resolve(core)
    loading ??= load().then(
      (m) => {
        const c = m.walletCore({ ...ui, setKeypair: (kp) => show(shown(kp)) })
        c.open(o)
        core = c
        return c
      },
      (err: unknown) => {
        loading = null
        throw err
      },
    )
    return loading
  }

  /** `act` once the core has loaded, in the order the actions came; `none` before the mount. */
  function run<T>(act: (c: WalletCore) => T, none: T): Promise<T> {
    if (!opened) return Promise.resolve(none)
    return rules(opened).then(act)
  }

  return {
    /** The page loaded: reads the store, loads no key code, asks nothing and writes nothing. */
    mount(storage: () => KeyStore): Opened {
      const o = openKeyStore(storage)
      opened = o
      read(o)
      return o
    },
    /** Another tab changed the wallet keys: follow it (the core does, once it has loaded). */
    sync(): void {
      if (core) core.sync()
      else if (opened) read(opened)
    },
    /** The key code has loaded (after the first action). */
    loaded: (): boolean => core !== null,
    /**
     * "Set up wallet": the dialog, with nothing waiting behind it. A device that ticked the box
     * before but lost its burner gets it back as the core opens the store (loadWallet), as its
     * page load did before R5c: then nothing is left to ask, and the sheet opens for the new
     * wallet instead of a second 18+ question.
     */
    ask: (): Promise<void> => run((c) => (current === null ? c.ask() : ui.created()), undefined),
    /** The dialog's Continue and Cancel: only the core opens it, so the core is there. */
    confirm(): void {
      core?.confirm()
    },
    cancel(): void {
      core?.cancel()
    },
    /**
     * Runs `send` with the burner once the 18+ box is ticked (WalletCore.withAge). Rejects when
     * the key code cannot load, or with what `send` itself threw, never as a refused save.
     */
    withAge: (send: Send, action: GateAction = 'trade', affirmedHere: unknown = false) =>
      run((c) => c.withAge(send, action, affirmedHere), undefined),
    /** Replaces the burner (WalletCore.importKey); rejects with the key's own problem. */
    importKey: (text: string, affirmed: boolean): Promise<boolean> =>
      run((c) => c.importKey(text, affirmed), false),
  }
}

export type WalletLoader = ReturnType<typeof walletLoader>
