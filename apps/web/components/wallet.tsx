'use client'
// The burner wallet for the whole app, plus the wallet's portfolio (positions and mUSDC),
// polled once here so the header, the trade panel and the claim button agree. The Claim all
// run lives here too: its button shows in the wallet sheet and on the game page, and only
// one run may be in flight.
//
// The 18+ self-declaration (spec section 12, R1) is asked here: no burner is created on a first
// visit until the box is ticked, and a burner that was never asked sends nothing (trade, claim,
// faucet) until it is. `withAge` is the only way a component gets the keypair to send with.
// A page load never asks (R5): the question comes with the first action, inline in the crown
// (`affirmedHere`) or in the AgeDialog otherwise (lib/age-gate.ts).
import type { PositionsResponse } from '@horagon/sdk'
import type { Keypair } from '@solana/web3.js'
import dynamic from 'next/dynamic'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  createAgeGate,
  type GateAction,
  type GateOutcome,
  gateClosesOnSync,
  loadWallet,
  type Send,
} from '../lib/age-gate'
import { api } from '../lib/api'
import {
  AGE_KEY,
  AgeRequired,
  affirmAge,
  ageAffirmed,
  BURNER_KEY,
  exportBurner,
  importBurner,
  type KeyStore,
  openKeyStore,
  peekBurner,
} from '../lib/burner'
import { requestFunds } from '../lib/faucet'
import { singleFlight } from '../lib/single-flight'
import { usePoll } from '../lib/use-poll'

// Off the first load (R5): the dialog is the fallback ask (the trade panel asks inline), and the
// claim code runs only when a position is claimable.
const AgeDialog = dynamic(() => import('./age-dialog').then((m) => m.AgeDialog), { ssr: false })

export type { Send }

interface WalletState {
  /** False until the browser storage was opened (first render, server render). */
  loaded: boolean
  address: string | null
  /** True when the browser blocks localStorage: the wallet lasts only for this tab. */
  ephemeral: boolean
  /** The 18+ box was never ticked on this device: every send asks first. */
  ageNeeded: boolean
  /**
   * How many burners this tab's AgeDialog has created. The wallet sheet opens when it grows, so
   * a new (empty) wallet goes to the faucet first. The crown's inline ask does not count: it
   * funds the new wallet itself and keeps the trade on screen.
   */
  walletsCreated: number
  portfolio: PositionsResponse | undefined
  refreshPortfolio: () => void
  exportKey: () => string
  /**
   * Replaces the burner. `affirmed`: the import form's own 18+ box was ticked, so the flag is
   * set first. False when the 18+ gate was shown instead; throws the key's problem (bad text)
   * as an Error with a message for the user.
   */
  importKey: (text: string, affirmed: boolean) => boolean
  /**
   * Runs `send` with the burner once the 18+ box is ticked: at once when it already was. When
   * the gate has to create the burner first, only a `faucet` action goes ahead (`afterGate`).
   * `affirmedHere`: the crown's own box was ticked for this action, so no dialog opens.
   */
  withAge: (send: Send, action?: GateAction, affirmedHere?: boolean) => void
  /** Shows the 18+ gate; ticking it creates the burner. */
  openGate: () => void
  /** Starts Claim all (through the gate); does nothing while a run is in flight. */
  startClaims: () => void
  /** A Claim all run is in flight: every Claim all button is disabled. */
  claiming: boolean
  /** Claims of the last run that landed, in order, kept when a later one failed. */
  claimed: string[]
  /** What stopped the last Claim all run, if anything. */
  claimError: unknown
  /**
   * Asks the faucet for play mUSDC for the burner, through the 18+ gate; refreshes the balance
   * after it lands. One request at a time. The wallet sheet and the trade panel both use it; the
   * crown passes `affirmedHere` when its own box was ticked, which also creates a missing burner.
   */
  requestFaucet: (affirmedHere?: boolean) => void
  /** A faucet request is in flight. */
  funding: boolean
  /** What the last faucet request added, until the next one starts. */
  fundNote: string | undefined
  /** What stopped the last faucet request, if anything. */
  fundError: unknown
}

const WalletContext = createContext<WalletState | null>(null)

const SAVE_FAILED = 'This browser refused to save the wallet. Try again.'

interface Opened {
  store: KeyStore
  ephemeral: boolean
}

interface ClaimRun {
  claiming: boolean
  claimed: string[]
  error: unknown
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<Opened | null>(null)
  const [keypair, setKeypair] = useState<Keypair | null>(null)
  const [ageOk, setAgeOk] = useState(false)
  const [gateOpen, setGateOpen] = useState(false)
  const [gateError, setGateError] = useState<string>()
  const [walletsCreated, setWalletsCreated] = useState(0)
  const [claimRun, setClaimRun] = useState<ClaimRun>({
    claiming: false,
    claimed: [],
    error: undefined,
  })
  const [fund, setFund] = useState<{ busy: boolean; note?: string; error?: unknown }>({
    busy: false,
  })
  const fundBusy = useRef(false)
  // What the gate continues once the box is ticked (one at a time; a new ask replaces it).
  const gate = useMemo(() => createAgeGate(), [])
  const claimFlight = useMemo(() => singleFlight(), [])

  const show = useCallback((error?: string) => {
    setGateError(error)
    setGateOpen(true)
  }, [])

  /** The dialog with nothing waiting behind it ("Set up wallet", Import without the box). */
  const ask = useCallback(() => {
    gate.askOnly()
    show()
  }, [gate, show])

  useEffect(() => {
    const o = openKeyStore(() => window.localStorage)
    setOpened(o)
    setAgeOk(ageAffirmed(o.store))
    // R5: a page load never asks. A first visit has no burner until an action asks.
    setKeypair(loadWallet(o.store))
    // Another tab imported, created or removed the key, or ticked the box: follow it, so two
    // tabs never sign with different wallets. Reads only. A removed burner waits for the next
    // action to ask; a gate left open here closes once that tab confirmed (unless an action
    // waits here).
    const onStorage = (e: StorageEvent) => {
      if (o.ephemeral || e.storageArea !== window.localStorage) return
      if (e.key !== null && e.key !== BURNER_KEY && e.key !== AGE_KEY) return
      const kp = peekBurner(o.store)
      setKeypair(kp)
      setAgeOk(ageAffirmed(o.store))
      if (kp !== null && gateClosesOnSync(o.store, gate.waiting())) setGateOpen(false)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [gate])

  const onConfirm = useCallback(() => {
    if (!opened) return
    let r: { keypair: Keypair; created: boolean }
    try {
      // A new wallet holds nothing yet: a waiting trade or claim is dropped, the faucet goes.
      r = gate.confirm(opened.store)
    } catch {
      setAgeOk(ageAffirmed(opened.store))
      setGateError(SAVE_FAILED)
      return
    }
    setAgeOk(true)
    setKeypair(r.keypair)
    setGateOpen(false)
    if (r.created) setWalletsCreated((n) => n + 1)
  }, [opened, gate])

  const onCancel = useCallback(() => {
    gate.cancel()
    setGateOpen(false)
  }, [gate])

  const withAge = useCallback(
    (send: Send, action: GateAction = 'trade', affirmedHere = false) => {
      if (!opened) return
      let out: GateOutcome
      try {
        // Strictly true: a click handler's event passed by mistake never counts as a tick.
        out = gate.request(opened.store, keypair, send, action, affirmedHere === true)
      } catch {
        // Only an inline tick writes here: storage refused it, so the dialog says so.
        setAgeOk(ageAffirmed(opened.store))
        show(SAVE_FAILED)
        return
      }
      if (out.ask) {
        show()
        return
      }
      // An inline tick set the flag and may have created the burner. The wallet sheet does not
      // open for it: the crown that asked stays on screen.
      setAgeOk(true)
      setKeypair(out.keypair)
    },
    [opened, keypair, gate, show],
  )

  const importKey = useCallback(
    (text: string, affirmed: boolean): boolean => {
      if (!opened) return false
      if (affirmed) {
        affirmAge(opened.store)
        setAgeOk(true)
      }
      try {
        setKeypair(importBurner(opened.store, text))
        setAgeOk(true)
        return true
      } catch (err) {
        // Never a raw error for the age question: ask it instead.
        if (!(err instanceof AgeRequired)) throw err
        ask()
        return false
      }
    },
    [opened, ask],
  )

  const address = keypair?.publicKey.toBase58() ?? null
  const portfolio = usePoll(address && `portfolio:${address}`, () =>
    api.portfolio(address as string),
  )
  const refreshPortfolio = portfolio.refresh

  const runClaims = useCallback(
    (signer: Keypair) =>
      void claimFlight.run(async () => {
        setClaimRun({ claiming: true, claimed: [], error: undefined })
        try {
          const { claimAll } = await import('../lib/trade')
          // Each claim shows as it lands, so a later failure still lists the ones before it.
          await claimAll(api, signer, (sig) =>
            setClaimRun((run) => ({ ...run, claimed: [...run.claimed, sig] })),
          )
          setClaimRun((run) => ({ ...run, claiming: false }))
        } catch (err) {
          setClaimRun((run) => ({ ...run, claiming: false, error: err }))
        } finally {
          refreshPortfolio()
        }
      }),
    [claimFlight, refreshPortfolio],
  )

  const requestFaucet = useCallback(
    (affirmedHere = false) => {
      const fundIt = (kp: Keypair) => {
        if (fundBusy.current) return
        fundBusy.current = true
        setFund({ busy: true })
        requestFunds(api, kp.publicKey.toBase58())
          .then((note) => {
            setFund({ busy: false, note })
            refreshPortfolio()
          })
          .catch((error: unknown) => setFund({ busy: false, error }))
          .finally(() => {
            fundBusy.current = false
          })
      }
      withAge(fundIt, 'faucet', affirmedHere === true)
    },
    [withAge, refreshPortfolio],
  )

  const startClaims = useCallback(() => {
    if (!claimFlight.running()) withAge(runClaims, 'claim')
  }, [claimFlight, withAge, runClaims])

  const value = useMemo<WalletState>(
    () => ({
      loaded: opened !== null,
      address,
      ephemeral: opened?.ephemeral ?? false,
      ageNeeded: !ageOk,
      walletsCreated,
      portfolio: portfolio.data,
      refreshPortfolio,
      exportKey: () => (keypair ? exportBurner(keypair) : ''),
      importKey,
      withAge,
      openGate: ask,
      startClaims,
      claiming: claimRun.claiming,
      claimed: claimRun.claimed,
      claimError: claimRun.error,
      requestFaucet,
      funding: fund.busy,
      fundNote: fund.note,
      fundError: fund.error,
    }),
    [
      opened,
      keypair,
      address,
      ageOk,
      walletsCreated,
      portfolio.data,
      refreshPortfolio,
      importKey,
      withAge,
      ask,
      startClaims,
      claimRun,
      requestFaucet,
      fund,
    ],
  )
  return (
    <WalletContext.Provider value={value}>
      {children}
      {gateOpen && <AgeDialog open error={gateError} onConfirm={onConfirm} onCancel={onCancel} />}
    </WalletContext.Provider>
  )
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWallet must be used inside <WalletProvider>')
  return ctx
}
