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
// (`affirmedHere`) or in the AgeDialog otherwise (lib/age-gate.ts). The rules themselves live in
// lib/wallet-core.ts, without React; this provider holds their state and the DOM's side.
//
// A page load has no web3.js either (R5c): the address comes from the stored key's bytes
// (lib/key-store.ts), the portfolio from the API, and the rules with their key code load with the
// first action (lib/wallet-loader.ts).
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
import type { GateAction, Send } from '../lib/age-gate'
import { api } from '../lib/api'
import { AGE_KEY, BURNER_KEY, exportSecret, type StoredBurner } from '../lib/key-store'
import { singleFlight } from '../lib/single-flight'
import { usePoll } from '../lib/use-poll'
import type { Opened } from '../lib/wallet-core'
import { walletLoader } from '../lib/wallet-loader'

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
   * set first. False when the 18+ gate was shown instead; rejects with the key's problem (bad
   * text) as an Error with a message for the user.
   */
  importKey: (text: string, affirmed: boolean) => Promise<boolean>
  /**
   * Runs `send` with the burner once the 18+ box is ticked: at once when it already was. When
   * the gate has to create the burner first, only a `faucet` action goes ahead (`afterGate`).
   * `affirmedHere`: the crown's own box was ticked for this action, so no dialog opens. Rejects
   * when the wallet's key code cannot load (the caller shows it).
   */
  withAge: (send: Send, action?: GateAction, affirmedHere?: boolean) => Promise<void>
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

interface ClaimRun {
  claiming: boolean
  claimed: string[]
  error: unknown
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<Opened | null>(null)
  const [burner, setBurner] = useState<StoredBurner | null>(null)
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
  // The burner and the 18+ gate (lib/wallet-loader.ts, then lib/wallet-core.ts): one per
  // provider, for its whole life.
  const [core] = useState(() =>
    walletLoader({
      setBurner,
      setAgeOk,
      openGate: (error?: string) => {
        setGateError(error)
        setGateOpen(true)
      },
      closeGate: () => setGateOpen(false),
      created: () => setWalletsCreated((n) => n + 1),
    }),
  )
  const claimFlight = useMemo(() => singleFlight(), [])

  useEffect(() => {
    // R5: a page load never asks. A first visit has no burner until an action asks.
    const o = core.mount(() => window.localStorage)
    setOpened(o)
    const onStorage = (e: StorageEvent) => {
      if (o.ephemeral || e.storageArea !== window.localStorage) return
      if (e.key !== null && e.key !== BURNER_KEY && e.key !== AGE_KEY) return
      core.sync()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [core])

  const address = burner?.address ?? null
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
        // The faucet call loads with the request (R5c); a failed load shows as its error.
        import('../lib/faucet')
          .then(({ requestFunds }) => requestFunds(api, kp.publicKey.toBase58()))
          .then((note) => {
            setFund({ busy: false, note })
            refreshPortfolio()
          })
          .catch((error: unknown) => setFund({ busy: false, error }))
          .finally(() => {
            fundBusy.current = false
          })
      }
      // The key code loads with this first action (R5c); a failed load shows as the fund error.
      core
        .withAge(fundIt, 'faucet', affirmedHere === true)
        .catch((error: unknown) => setFund({ busy: false, error }))
    },
    [core, refreshPortfolio],
  )

  const startClaims = useCallback(() => {
    if (claimFlight.running()) return
    core
      .withAge(runClaims, 'claim')
      .catch((error: unknown) => setClaimRun({ claiming: false, claimed: [], error }))
  }, [claimFlight, core, runClaims])

  const openGate = useCallback(() => {
    core.ask().catch((error: unknown) => setFund({ busy: false, error }))
  }, [core])

  const value = useMemo<WalletState>(
    () => ({
      loaded: opened !== null,
      address,
      ephemeral: opened?.ephemeral ?? false,
      ageNeeded: !ageOk,
      walletsCreated,
      portfolio: portfolio.data,
      refreshPortfolio,
      exportKey: () => (burner ? exportSecret(burner.secretKey) : ''),
      importKey: core.importKey,
      withAge: core.withAge,
      openGate,
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
      burner,
      address,
      ageOk,
      walletsCreated,
      portfolio.data,
      refreshPortfolio,
      core,
      openGate,
      startClaims,
      claimRun,
      requestFaucet,
      fund,
    ],
  )
  return (
    <WalletContext.Provider value={value}>
      {children}
      {gateOpen && (
        <AgeDialog open error={gateError} onConfirm={core.confirm} onCancel={core.cancel} />
      )}
    </WalletContext.Provider>
  )
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWallet must be used inside <WalletProvider>')
  return ctx
}
