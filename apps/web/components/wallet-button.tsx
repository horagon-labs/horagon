'use client'
// Header wallet: balance and address; the sheet has test funds, positions, Export and Import.
// The sheet opens by itself when the 18+ gate has just created a wallet: it starts empty, so
// the faucet comes first. The YourHour chip opens it at the positions (Chronometer spec 3.2).
import dynamic from 'next/dynamic'
import { useEffect, useRef, useState } from 'react'
import { shortKey, usdc } from '../lib/format'
import { YourHour } from './chrono/your-hour'
import { useWallet } from './wallet'

// The sheet's body loads on the first open (R5): it is not part of a page's first load.
const WalletSheet = dynamic(() => import('./wallet-sheet'), {
  ssr: false,
  loading: () => <p className="text-13 text-ash-400">Loading the wallet…</p>,
})

export function WalletButton() {
  const { loaded, address, walletsCreated, portfolio, openGate } = useWallet()
  const dialog = useRef<HTMLDialogElement>(null)
  const [sheet, setSheet] = useState<{ atPositions: boolean } | null>(null)
  const seenCreated = useRef(walletsCreated)

  function open(atPositions: boolean) {
    setSheet({ atPositions })
    const d = dialog.current
    if (d && !d.open) d.showModal()
  }

  useEffect(() => {
    if (walletsCreated === seenCreated.current) return
    seenCreated.current = walletsCreated
    setSheet({ atPositions: false })
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

  const balance = portfolio?.usdcBalance
  return (
    <div className="flex items-center gap-2">
      <YourHour
        portfolio={portfolio?.wallet === address ? portfolio : undefined}
        onOpen={() => open(true)}
      />
      <button
        type="button"
        onClick={() => open(false)}
        className="min-h-11 rounded-full border border-line px-3 font-mono text-13 text-ivory-100 tabular-nums"
      >
        {balance === undefined || balance === null ? '–' : usdc(balance)} mUSDC ·{' '}
        {shortKey(address)}
      </button>
      <dialog
        ref={dialog}
        aria-label="Play wallet"
        onClose={() => setSheet(null)}
        className="m-auto w-[min(32rem,calc(100%-2rem))] rounded-face border border-brass-500/20 bg-enamel-900 p-5 text-ivory-100 backdrop:bg-black/70"
      >
        {sheet && (
          <WalletSheet atPositions={sheet.atPositions} onClose={() => dialog.current?.close()} />
        )}
      </dialog>
    </div>
  )
}
