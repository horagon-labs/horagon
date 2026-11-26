'use client'
// Header wallet: balance and address; the sheet has test funds, positions, Export and Import.
// The sheet opens by itself when the 18+ gate has just created a wallet: it starts empty, so
// the faucet comes first. The YourHour chip opens it at the positions (Chronometer spec 3.2).
import { useEffect, useRef, useState } from 'react'
import { shortKey, usdc } from '../lib/format'
import { FAUCET_BUTTON, readyHint, replacePrompt } from '../lib/wallet-copy'
import { AgeCheckbox } from './age-dialog'
import { FeelToggles } from './chrono/feel-toggles'
import { YourHour } from './chrono/your-hour'
import { ErrorText } from './error-text'
import { Positions } from './positions'
import { useWallet } from './wallet'

export function WalletButton() {
  const {
    loaded,
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
    openGate,
  } = useWallet()
  const dialog = useRef<HTMLDialogElement>(null)
  const [shown, setShown] = useState<string>()
  const [importText, setImportText] = useState('')
  const [importAge, setImportAge] = useState(false)
  const [importError, setImportError] = useState<string>()
  const [note, setNote] = useState<string>()
  const seenCreated = useRef(walletsCreated)
  const positions = useRef<HTMLElement>(null)

  useEffect(() => {
    if (walletsCreated === seenCreated.current) return
    seenCreated.current = walletsCreated
    const d = dialog.current
    if (d && !d.open) d.showModal()
  }, [walletsCreated])

  if (!loaded) return <span className="text-13 text-ash-400">Wallet…</span>
  if (!address) {
    return (
      <button
        type="button"
        onClick={openGate}
        className="min-h-11 rounded-full border border-brass-500/40 px-4 text-13 text-brass-400"
      >
        Set up wallet
      </button>
    )
  }

  function onImport() {
    if (!window.confirm(replacePrompt(ephemeral))) return
    setImportError(undefined)
    try {
      if (!importKey(importText, importAge)) return
      setImportText('')
      setImportAge(false)
      setShown(undefined)
      setNote('Wallet imported.')
    } catch (err) {
      // The key's own problem (not base58, wrong length, mismatched halves), in words.
      setImportError(err instanceof Error ? err.message : 'This key could not be imported.')
    }
  }

  const balance = portfolio?.usdcBalance
  // The faucet hint for a wallet created in this tab, until it holds mUSDC.
  const hint = readyHint(walletsCreated > 0, portfolio?.wallet === address ? balance : undefined)
  function openAtPositions() {
    dialog.current?.showModal()
    positions.current?.scrollIntoView({ block: 'start' })
  }

  return (
    <div className="flex items-center gap-2">
      <YourHour
        portfolio={portfolio?.wallet === address ? portfolio : undefined}
        onOpen={openAtPositions}
      />
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="min-h-11 rounded-full border border-line px-3 font-mono text-13 text-ivory-100 tabular-nums"
      >
        {balance === undefined || balance === null ? '–' : usdc(balance)} mUSDC ·{' '}
        {shortKey(address)}
      </button>
      <dialog
        ref={dialog}
        aria-label="Play wallet"
        className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-face border border-brass-500/20 bg-enamel-900 p-5 text-ivory-100 backdrop:bg-black/70"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-15 font-semibold">Play wallet (devnet)</h2>
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              aria-label="Close"
              className="grid size-11 place-items-center"
            >
              ✕
            </button>
          </div>
          <p className="break-all font-mono text-11 text-ash-400">{address}</p>
          {ephemeral && (
            <p className="text-13 text-amber-400">
              This browser blocks storage: the wallet disappears when you close the tab. Export it
              to keep it.
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
            <summary className="min-h-11 cursor-pointer text-13 font-semibold">
              Export / Import
            </summary>
            <div className="mt-2 space-y-2 text-13">
              <p className="text-ash-400">
                The secret key controls this wallet. Anyone with it can trade as you.
              </p>
              {shown ? (
                <p className="break-all rounded bg-enamel-800 p-2 font-mono text-11">{shown}</p>
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
                className="h-20 w-full rounded border border-line bg-transparent p-2 font-mono text-11"
              />
              {ageNeeded && <AgeCheckbox checked={importAge} onChange={setImportAge} />}
              <button
                type="button"
                disabled={!importText.trim() || (ageNeeded && !importAge)}
                onClick={onImport}
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
      </dialog>
    </div>
  )
}
