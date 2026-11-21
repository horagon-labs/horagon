'use client'
// The burner wallet for the whole app, plus the wallet's portfolio (positions and mUSDC),
// polled once here so the header, the trade panel and the claim button agree.
//
// The 18+ self-declaration (spec section 12, R1) is asked here: no burner is created on a first
// visit until the box is ticked, and a burner that was never asked sends nothing (trade, claim,
// faucet) until it is. `withAge` is the only way a component gets the keypair to send with.
import type { PositionsResponse } from '@horagon/sdk'
import type { Keypair } from '@solana/web3.js'
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
import { walletGate } from '../lib/age-gate'
import { api } from '../lib/api'
import {
  AGE_KEY,
  AgeRequired,
  affirmAge,
  ageAffirmed,
  BURNER_KEY,
  ensureBurner,
  exportBurner,
  importBurner,
  type KeyStore,
  openKeyStore,
  peekBurner,
} from '../lib/burner'
import { usePoll } from '../lib/use-poll'
import { AgeDialog } from './age-dialog'

/** Something that sends with the burner: a trade, a claim, a faucet request. */
export type Send = (keypair: Keypair) => void

interface WalletState {
  /** False until the browser storage was opened (first render, server render). */
  loaded: boolean
  address: string | null
  /** True when the browser blocks localStorage: the wallet lasts only for this tab. */
  ephemeral: boolean
  /** The 18+ box was never ticked on this device: every send asks first. */
  ageNeeded: boolean
  portfolio: PositionsResponse | undefined
  refreshPortfolio: () => void
  exportKey: () => string
  /**
   * Replaces the burner. `affirmed`: the import form's own 18+ box was ticked, so the flag is
   * set first. False when the 18+ gate was shown instead; throws the key's problem (bad text)
   * as an Error with a message for the user.
   */
  importKey: (text: string, affirmed: boolean) => boolean
  /** Runs `send` with the burner once the 18+ box is ticked: at once when it already was. */
  withAge: (send: Send) => void
  /** Shows the 18+ gate; ticking it creates the burner. */
  openGate: () => void
}

const WalletContext = createContext<WalletState | null>(null)

const SAVE_FAILED = 'This browser refused to save the wallet. Try again.'

interface Opened {
  store: KeyStore
  ephemeral: boolean
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<Opened | null>(null)
  const [keypair, setKeypair] = useState<Keypair | null>(null)
  const [ageOk, setAgeOk] = useState(false)
  const [gateOpen, setGateOpen] = useState(false)
  const [gateError, setGateError] = useState<string>()
  // What the gate continues once the box is ticked (one at a time; a new ask replaces it).
  const pending = useRef<Send | null>(null)

  const ask = useCallback((send: Send | null, error?: string) => {
    pending.current = send
    setGateError(error)
    setGateOpen(true)
  }, [])

  useEffect(() => {
    const o = openKeyStore(() => window.localStorage)
    setOpened(o)
    setAgeOk(ageAffirmed(o.store))
    // A first visit creates nothing: the gate asks, and its confirm creates the burner.
    if (walletGate(o.store) === 'ask-new') {
      ask(null)
    } else {
      try {
        setKeypair(ensureBurner(o.store))
      } catch (err) {
        ask(null, err instanceof AgeRequired ? undefined : SAVE_FAILED)
      }
    }
    // Another tab imported, created or removed the key, or ticked the box: follow it, so two
    // tabs never sign with different wallets. Reads only; a removed burner shows the gate.
    const onStorage = (e: StorageEvent) => {
      if (o.ephemeral || e.storageArea !== window.localStorage) return
      if (e.key !== null && e.key !== BURNER_KEY && e.key !== AGE_KEY) return
      const kp = peekBurner(o.store)
      setKeypair(kp)
      setAgeOk(ageAffirmed(o.store))
      if (kp === null) ask(null)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [ask])

  const onConfirm = useCallback(() => {
    if (!opened) return
    let kp: Keypair
    try {
      affirmAge(opened.store)
      kp = ensureBurner(opened.store)
    } catch {
      setAgeOk(ageAffirmed(opened.store))
      setGateError(SAVE_FAILED)
      return
    }
    setAgeOk(true)
    setKeypair(kp)
    setGateOpen(false)
    const send = pending.current
    pending.current = null
    send?.(kp)
  }, [opened])

  const onCancel = useCallback(() => {
    pending.current = null
    setGateOpen(false)
  }, [])

  const withAge = useCallback(
    (send: Send) => {
      // The stored flag is the truth (another tab may have changed it since the last render).
      if (opened && keypair && ageAffirmed(opened.store)) send(keypair)
      else ask(send)
    },
    [opened, keypair, ask],
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
        ask(null)
        return false
      }
    },
    [opened, ask],
  )

  const address = keypair?.publicKey.toBase58() ?? null
  const portfolio = usePoll(address && `portfolio:${address}`, () =>
    api.portfolio(address as string),
  )

  const value = useMemo<WalletState>(
    () => ({
      loaded: opened !== null,
      address,
      ephemeral: opened?.ephemeral ?? false,
      ageNeeded: !ageOk,
      portfolio: portfolio.data,
      refreshPortfolio: portfolio.refresh,
      exportKey: () => (keypair ? exportBurner(keypair) : ''),
      importKey,
      withAge,
      openGate: () => ask(null),
    }),
    [opened, keypair, address, ageOk, portfolio.data, portfolio.refresh, importKey, withAge, ask],
  )
  return (
    <WalletContext.Provider value={value}>
      {children}
      <AgeDialog open={gateOpen} error={gateError} onConfirm={onConfirm} onCancel={onCancel} />
    </WalletContext.Provider>
  )
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWallet must be used inside <WalletProvider>')
  return ctx
}
