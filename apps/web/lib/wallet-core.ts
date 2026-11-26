// What WalletProvider does with the burner and the 18+ gate, without React (R5 review finding 12),
// so the rules are tested in Node: the mount, the storage sync of another tab, "Set up wallet",
// the dialog's Continue and Cancel, `withAge` and Import. The provider holds the React state and
// passes its setters in as `WalletUi`; nothing here touches the DOM.
//
// A mount never asks (R5): it reads the store, loads a burner that exists, and writes nothing on a
// first visit. Only an action opens the dialog. A save is the only thing caught here (finding 11):
// the gate hands each send back (`go`), and it runs after the catch, so an error it throws is
// never shown as a refused save.
import type { Keypair } from '@solana/web3.js'
import {
  createAgeGate,
  type GateAction,
  type GateOutcome,
  gateClosesOnSync,
  loadWallet,
  type Send,
} from './age-gate'
import {
  AgeRequired,
  affirmAge,
  ageAffirmed,
  importBurner,
  type KeyStore,
  openKeyStore,
  peekBurner,
} from './burner'

/** The provider's side: React state setters and the dialog. */
export interface WalletUi {
  setKeypair: (keypair: Keypair | null) => void
  setAgeOk: (ok: boolean) => void
  /** Opens the AgeDialog, with an error line or none. */
  openGate: (error?: string) => void
  closeGate: () => void
  /** The AgeDialog created a burner (the wallet sheet opens for it). */
  created: () => void
}

export interface Opened {
  store: KeyStore
  ephemeral: boolean
}

export const SAVE_FAILED = 'This browser refused to save the wallet. Try again.'

export function walletCore(ui: WalletUi, gate = createAgeGate()) {
  let opened: Opened | null = null
  let keypair: Keypair | null = null
  const setKeypair = (kp: Keypair | null) => {
    keypair = kp
    ui.setKeypair(kp)
  }

  /** The dialog with nothing waiting behind it ("Set up wallet", Import without the box). */
  const ask = (): void => {
    gate.askOnly()
    ui.openGate()
  }

  return {
    gate,
    /** The page loaded (R5): reads only, asks nothing; a first visit has no burner. */
    mount(storage: () => KeyStore): Opened {
      const o = openKeyStore(storage)
      opened = o
      ui.setAgeOk(ageAffirmed(o.store))
      setKeypair(loadWallet(o.store))
      return o
    },
    /**
     * Another tab imported, created or removed the key, or ticked the box: follow it, so two tabs
     * never sign with different wallets. Reads only. A removed burner waits for the next action
     * to ask; a dialog open here closes once that tab confirmed, unless an action waits here.
     */
    sync(): void {
      if (!opened) return
      const kp = peekBurner(opened.store)
      setKeypair(kp)
      ui.setAgeOk(ageAffirmed(opened.store))
      if (kp !== null && gateClosesOnSync(opened.store, gate.waiting())) ui.closeGate()
    },
    ask,
    /** The dialog's box was ticked: the flag, the burner, then what waited behind it. */
    confirm(): void {
      if (!opened) return
      let r: ReturnType<typeof gate.confirm>
      try {
        // A new wallet holds nothing yet: a waiting trade or claim is dropped, the faucet goes.
        r = gate.confirm(opened.store)
      } catch {
        ui.setAgeOk(ageAffirmed(opened.store))
        ui.openGate(SAVE_FAILED)
        return
      }
      ui.setAgeOk(true)
      setKeypair(r.keypair)
      ui.closeGate()
      if (r.created) ui.created()
      r.go?.()
    },
    cancel(): void {
      gate.cancel()
      ui.closeGate()
    },
    /**
     * Runs `send` with the burner once the 18+ box is ticked: at once when it already was.
     * `affirmedHere`: the crown's own box was ticked for this action; only a strict `true`
     * counts, so a click event passed by mistake never passes for the tick.
     */
    withAge(send: Send, action: GateAction = 'trade', affirmedHere: unknown = false): void {
      if (!opened) return
      let out: GateOutcome
      try {
        out = gate.request(opened.store, keypair, send, action, affirmedHere === true)
      } catch {
        // Only an inline tick saves here: storage refused it, so the dialog says so.
        ui.setAgeOk(ageAffirmed(opened.store))
        ui.openGate(SAVE_FAILED)
        return
      }
      if (out.ask) {
        ui.openGate()
        return
      }
      // An inline tick set the flag and may have created the burner. The wallet sheet does not
      // open for it: the crown that asked stays on screen.
      ui.setAgeOk(true)
      setKeypair(out.keypair)
      out.go?.()
    },
    /**
     * Replaces the burner. `affirmed`: the import form's own 18+ box was ticked, so the flag is
     * set first. False when the dialog was shown instead; throws the key's problem (bad text).
     */
    importKey(text: string, affirmed: boolean): boolean {
      if (!opened) return false
      if (affirmed === true) {
        affirmAge(opened.store)
        ui.setAgeOk(true)
      }
      try {
        setKeypair(importBurner(opened.store, text))
        ui.setAgeOk(true)
        return true
      } catch (err) {
        // Never a raw error for the age question: ask it instead.
        if (!(err instanceof AgeRequired)) throw err
        ask()
        return false
      }
    },
  }
}

export type WalletCore = ReturnType<typeof walletCore>
