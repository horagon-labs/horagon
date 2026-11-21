'use client'
// Header wallet: balance and address; the sheet has test funds, positions, Export and Import.
// The sheet opens by itself when the 18+ gate has just created a wallet: it starts empty, so
// the faucet comes first.
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { shortKey, usdc } from '../lib/format'
import { readyHint, replacePrompt } from '../lib/wallet-copy'
import { AgeCheckbox } from './age-dialog'
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
    refreshPortfolio,
    exportKey,
    importKey,
    withAge,
    openGate,
  } = useWallet()
  const dialog = useRef<HTMLDialogElement>(null)
  const [shown, setShown] = useState<string>()
  const [importText, setImportText] = useState('')
  const [importAge, setImportAge] = useState(false)
  const [importError, setImportError] = useState<string>()
  const [funding, setFunding] = useState(false)
  const [note, setNote] = useState<string>()
  const [error, setError] = useState<unknown>()
  const seenCreated = useRef(walletsCreated)

  useEffect(() => {
    if (walletsCreated === seenCreated.current) return
    seenCreated.current = walletsCreated
    const d = dialog.current
    if (d && !d.open) d.showModal()
  }, [walletsCreated])

  if (!loaded) return <span className="text-sm text-zinc-500">Wallet…</span>
  if (!address) {
    return (
      <button
        type="button"
        onClick={openGate}
        className="rounded-full border border-zinc-300 px-3 py-1 text-sm dark:border-zinc-700"
      >
        Set up wallet
      </button>
    )
  }

  async function fund(wallet: string) {
    setFunding(true)
    setError(undefined)
    setNote(undefined)
    try {
      const r = await api.faucet(wallet)
      setNote(`Added ${usdc(r.amountUsdc)} test mUSDC.`)
      refreshPortfolio()
    } catch (err) {
      setError(err)
    } finally {
      setFunding(false)
    }
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
      setError(undefined)
    } catch (err) {
      // The key's own problem (not base58, wrong length, mismatched halves), in words.
      setImportError(err instanceof Error ? err.message : 'This key could not be imported.')
    }
  }

  const balance = portfolio?.usdcBalance
  // The faucet hint for a wallet created in this tab, until it holds mUSDC.
  const hint = readyHint(walletsCreated > 0, portfolio?.wallet === address ? balance : undefined)
  return (
    <>
      <button
        type="button"
        onClick={() => dialog.current?.showModal()}
        className="rounded-full border border-zinc-300 px-3 py-1 text-sm dark:border-zinc-700"
      >
        {balance === undefined || balance === null ? '–' : usdc(balance)} mUSDC ·{' '}
        {shortKey(address)}
      </button>
      <dialog
        ref={dialog}
        aria-label="Burner wallet"
        className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-xl bg-white p-4 text-zinc-900 backdrop:bg-black/50 dark:bg-zinc-900 dark:text-zinc-100"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Burner wallet (devnet)</h2>
            <button type="button" onClick={() => dialog.current?.close()} aria-label="Close">
              ✕
            </button>
          </div>
          <p className="break-all font-mono text-xs">{address}</p>
          {ephemeral && (
            <p className="text-sm text-amber-600">
              This browser blocks storage: the wallet disappears when you close the tab. Export it
              to keep it.
            </p>
          )}
          {hint && <p className="text-sm font-medium">{hint}</p>}
          <button
            type="button"
            disabled={funding}
            onClick={() => withAge((kp) => void fund(kp.publicKey.toBase58()), 'faucet')}
            className="w-full rounded-lg bg-zinc-900 py-2 font-semibold text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {funding ? 'Requesting…' : 'Get test mUSDC'}
          </button>
          {note && <p className="text-sm text-emerald-600">{note}</p>}
          <ErrorText error={error} />
          <section>
            <h3 className="mb-1 text-sm font-semibold">Positions</h3>
            <Positions />
          </section>
          <details>
            <summary className="cursor-pointer text-sm font-semibold">Export / Import</summary>
            <div className="mt-2 space-y-2 text-sm">
              <p className="text-zinc-500">
                The secret key controls this wallet. Anyone with it can trade as you.
              </p>
              {shown ? (
                <p className="break-all rounded bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-800">
                  {shown}
                </p>
              ) : (
                <button type="button" className="underline" onClick={() => setShown(exportKey())}>
                  Show secret key (base58)
                </button>
              )}
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder="Paste a base58 secret key or a JSON byte array"
                aria-label="Secret key to import"
                className="h-20 w-full rounded border border-zinc-300 bg-transparent p-2 font-mono text-xs dark:border-zinc-700"
              />
              {ageNeeded && <AgeCheckbox checked={importAge} onChange={setImportAge} />}
              <button
                type="button"
                disabled={!importText.trim() || (ageNeeded && !importAge)}
                onClick={onImport}
                className="underline disabled:opacity-50"
              >
                Import
              </button>
              {importError && (
                <p role="alert" className="text-red-600 dark:text-red-400">
                  {importError}
                </p>
              )}
            </div>
          </details>
        </div>
      </dialog>
    </>
  )
}
