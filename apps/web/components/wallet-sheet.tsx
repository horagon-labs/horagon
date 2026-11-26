'use client'
// The play wallet sheet's body (R5): test funds, positions, motion settings, Export and Import.
// Loaded on the first open (components/wallet-button.tsx), so it is not part of a page's first
// load. Closing the sheet unmounts it, which also hides a shown secret key again.
import Link from 'next/link'
import { useEffect, useRef } from 'react'
import { FAUCET_BUTTON, readyHint, WALLET_PREPARING } from '../lib/wallet-copy'
import { FeelToggles } from './chrono/feel-toggles'
import { ErrorText } from './error-text'
import { KeyBackup } from './key-backup'
import { Positions } from './positions'
import { useWallet } from './wallet'

export default function WalletSheet(p: {
  /** Opened from the YourHour chip: scroll to the positions. */
  atPositions: boolean
  onClose: () => void
}) {
  const {
    address,
    ephemeral,
    walletsCreated,
    portfolio,
    requestFaucet,
    funding,
    fundNote,
    fundError,
    preparing,
  } = useWallet()
  const positions = useRef<HTMLElement>(null)

  useEffect(() => {
    if (p.atPositions) positions.current?.scrollIntoView({ block: 'start' })
  }, [p.atPositions])

  const balance = portfolio?.usdcBalance
  // My Game-day is linked only while the API sends the nights (FLAG_ME on), so a site with the
  // flag off never links a page that says it is switched off.
  const meOn = portfolio?.wallet === address && portfolio?.nights !== undefined
  // The faucet hint for a wallet created in this tab, until it holds mUSDC.
  const hint = readyHint(walletsCreated > 0, portfolio?.wallet === address ? balance : undefined)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-15 font-semibold">Play wallet (devnet)</h2>
        <button
          type="button"
          onClick={p.onClose}
          aria-label="Close"
          className="grid size-11 place-items-center"
        >
          ✕
        </button>
      </div>
      <p className="break-all font-mono text-12 text-ash-400">{address}</p>
      {ephemeral && (
        <p className="text-13 text-amber-400">
          This browser blocks storage: the wallet disappears when you close the tab. Export it to
          keep it.
        </p>
      )}
      {hint && <p className="text-13 font-medium">{hint}</p>}
      <button
        type="button"
        disabled={funding || preparing}
        onClick={() => requestFaucet()}
        className="min-h-11 w-full rounded-card bg-lume-300 py-2 font-semibold text-enamel-950 disabled:opacity-50"
      >
        {funding ? 'Requesting…' : preparing ? WALLET_PREPARING : FAUCET_BUTTON}
      </button>
      {fundNote && <p className="text-13 text-lume-300">{fundNote}</p>}
      <ErrorText error={fundError} />
      {meOn && (
        <Link
          href="/me"
          onClick={p.onClose}
          className="inline-flex min-h-11 items-center text-13 font-semibold text-lume-300 underline-offset-4 hover:underline"
        >
          My Game-day
        </Link>
      )}
      <section ref={positions} className="scroll-mt-4">
        <h3 className="mb-1 text-13 font-semibold">Positions</h3>
        <Positions />
      </section>
      <FeelToggles />
      <KeyBackup open={false} />
    </div>
  )
}
