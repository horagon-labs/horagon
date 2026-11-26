'use client'
// The wallet's Export / Import block (R7), moved out of the wallet sheet unchanged: open on My
// Game-day, folded in the sheet. It needs no key code to show the key (key-store's export text);
// an Import loads it (R5c), after the replace prompt and, on a device never asked, the 18+ box.
// Light on purpose: it imports only the wallet context, the wallet's words and the 18+ box.
import { useState } from 'react'
import { importErrorText, replacePrompt } from '../lib/wallet-copy'
import { AgeCheckbox } from './age-dialog'
import { useWallet } from './wallet'

export function KeyBackup(p: {
  /** Shown open (My Game-day); otherwise folded behind "Export / Import" (the wallet sheet). */
  open: boolean
}) {
  const { ephemeral, ageNeeded, exportKey, importKey } = useWallet()
  const [shown, setShown] = useState<string>()
  const [importText, setImportText] = useState('')
  const [importAge, setImportAge] = useState(false)
  const [importError, setImportError] = useState<string>()
  const [importing, setImporting] = useState(false)
  const [note, setNote] = useState<string>()

  async function onImport() {
    if (!window.confirm(replacePrompt(ephemeral))) return
    setImportError(undefined)
    setNote(undefined)
    setImporting(true)
    try {
      // The key code loads with the first import (R5c), so this waits for it, and says so.
      if (!(await importKey(importText, importAge))) return
      setImportText('')
      setImportAge(false)
      setShown(undefined)
      setNote('Wallet imported.')
    } catch (err) {
      // The key's own problem in words; a load that failed never calls the key bad.
      setImportError(importErrorText(err))
    } finally {
      setImporting(false)
    }
  }

  const body = (
    <div className="mt-2 space-y-2 text-13">
      <p className="text-ink-muted">
        The secret key controls this wallet. Anyone with it can trade as you.
      </p>
      {shown ? (
        <p className="break-all rounded bg-surface-sunk p-2 font-mono text-12">{shown}</p>
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
        className="h-20 w-full rounded border border-rule bg-transparent p-2 font-mono text-12"
      />
      {ageNeeded && <AgeCheckbox checked={importAge} onChange={setImportAge} />}
      <button
        type="button"
        disabled={importing || !importText.trim() || (ageNeeded && !importAge)}
        onClick={() => void onImport()}
        className="inline-flex min-h-11 items-center underline disabled:opacity-50"
      >
        {importing ? 'Importing…' : 'Import'}
      </button>
      {note && <p className="text-ink">{note}</p>}
      {importError && (
        <p role="alert" className="text-error">
          {importError}
        </p>
      )}
    </div>
  )

  if (p.open) {
    return (
      <section aria-labelledby="key-backup-title">
        <h2 id="key-backup-title" className="text-13 font-semibold">
          Export / Import
        </h2>
        {body}
      </section>
    )
  }
  return (
    <details>
      <summary className="min-h-11 cursor-pointer text-13 font-semibold">Export / Import</summary>
      {body}
    </details>
  )
}
