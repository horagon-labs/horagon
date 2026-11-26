'use client'
// The play wallet sheet's body (R5): test funds, positions, motion settings, Export and Import.
// Loaded on the first open (components/wallet-button.tsx), so it is not part of a page's first
// load. Closing the sheet unmounts it, which also hides a shown secret key again.
import { useEffect, useRef, useState } from 'react'
import { FAUCET_BUTTON, readyHint, replacePrompt } from '../lib/wallet-copy'
import { AgeCheckbox } from './age-dialog'
import { FeelToggles } from './chrono/feel-toggles'
import { ErrorText } from './error-text'
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
    ageNeeded,
    walletsCreated,
    portfolio,
    requestFaucet,
    funding,
    fundNote,
    fundError,
    exportKey,
    importKey,
  } = useWallet()
  const [shown, setShown] = useState<string>()
  const [importText, setImportText] = useState('')
  const [importAge, setImportAge] = useState(false)
  const [importError, setImportError] = useState<string>()
  const [note, setNote] = useState<string>()
  const positions = useRef<HTMLElement>(null)

  useEffect(() => {
    if (p.atPositions) positions.current?.scrollIntoView({ block: 'start' })
  }, [p.atPositions])

  async function onImport() {
    if (!window.confirm(replacePrompt(ephemeral))) return
    setImportError(undefined)
    try {
      // The key code loads with the first import (R5c), so this waits for it.
      if (!(await importKey(importText, importAge))) return
      setImportText('')
      setImportAge(false)
      setShown(undefined)
      setNote('Wallet imported.')
    } catch (err) {
      // The key's own problem (not base58, wrong length, mismatched halves), in words; a key
      // code that failed to load (a ChunkLoadError, a TypeError) gets no raw message.
      const own = err instanceof Error && err.name === 'Error'
      setImportError(own ? err.message : 'This key could not be imported.')
    }
  }

  const balance = portfolio?.usdcBalance
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
        disabled={funding}
        onClick={() => requestFaucet()}
        className="min-h-11 w-full rounded-card bg-lume-300 py-2 font-semibold text-enamel-950 disabled:opacity-50"
      >
        {funding ? 'Requesting…' : FAUCET_BUTTON}
      </button>
      {note && <p className="text-13 text-lume-300">{note}</p>}
      {fundNote && <p className="text-13 text-lume-300">{fundNote}</p>}
      <ErrorText error={fundError} />
      <section ref={positions} className="scroll-mt-4">
        <h3 className="mb-1 text-13 font-semibold">Positions</h3>
        <Positions />
      </section>
      <FeelToggles />
      <details>
        <summary className="min-h-11 cursor-pointer text-13 font-semibold">Export / Import</summary>
        <div className="mt-2 space-y-2 text-13">
          <p className="text-ash-400">
            The secret key controls this wallet. Anyone with it can trade as you.
          </p>
          {shown ? (
            <p className="break-all rounded bg-enamel-800 p-2 font-mono text-12">{shown}</p>
          ) : (
            <button
              type="button"
              className="inline-flex min-h-11 items-center underline"
              onClick={() => setShown(exportKey())}
            >
              Show secret key
            </button>
          )}
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="Paste a base58 secret key or a JSON byte array"
            aria-label="Secret key to import"
            className="h-20 w-full rounded border border-line bg-transparent p-2 font-mono text-12"
          />
          {ageNeeded && <AgeCheckbox checked={importAge} onChange={setImportAge} />}
          <button
            type="button"
            disabled={!importText.trim() || (ageNeeded && !importAge)}
            onClick={() => void onImport()}
            className="inline-flex min-h-11 items-center underline disabled:opacity-50"
          >
            Import
          </button>
          {importError && (
            <p role="alert" className="text-red-400">
              {importError}
            </p>
          )}
        </div>
      </details>
    </div>
  )
}
