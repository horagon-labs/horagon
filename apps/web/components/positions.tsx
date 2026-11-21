'use client'
import type { Keypair } from '@solana/web3.js'
import Link from 'next/link'
import { useRef, useState } from 'react'
import { api } from '../lib/api'
import { explorerTx, usdc } from '../lib/format'
import { claimAll } from '../lib/trade'
import { ErrorText } from './error-text'
import { useWallet } from './wallet'

export function Positions({ gameId }: { gameId?: string }) {
  const { portfolio, refreshPortfolio, withAge } = useWallet()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const [claimed, setClaimed] = useState<string[]>([])
  const running = useRef(false)

  const rows = (portfolio?.positions ?? []).filter((p) => !gameId || p.gameId === gameId)
  const claimable = rows.some((p) => p.claimable)

  async function claim(keypair: Keypair) {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError(undefined)
    setClaimed([])
    try {
      // Each claim shows as it lands, so a later failure still lists the ones before it.
      await claimAll(api, keypair, (sig) => setClaimed((done) => [...done, sig]))
    } catch (err) {
      setError(err)
    } finally {
      running.current = false
      setBusy(false)
      refreshPortfolio()
    }
  }

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No positions yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          {rows.map((p) => (
            <li key={`${p.market}-${p.side}`} className="flex items-center justify-between py-2">
              <div>
                <Link
                  href={`/game/${p.gameId}`}
                  className="font-medium underline-offset-2 hover:underline"
                >
                  {p.side.toUpperCase()} · {usdc(p.shares)} shares
                </Link>
                <p className="text-zinc-500">
                  cost {usdc(p.costUsdc)} · value {usdc(p.valueUsdc)} · {p.marketStatus}
                </p>
              </div>
              <span className={p.pnlUsdc.startsWith('-') ? 'text-red-600' : 'text-emerald-600'}>
                {p.pnlUsdc.startsWith('-') ? '' : '+'}
                {usdc(p.pnlUsdc)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {claimable && (
        <button
          type="button"
          disabled={busy}
          onClick={() => withAge((kp) => void claim(kp))}
          className="w-full rounded-lg bg-emerald-600 py-2 font-semibold text-white disabled:opacity-50"
        >
          {busy ? 'Claiming…' : 'Claim all'}
        </button>
      )}
      {claimed.map((sig) => (
        <a
          key={sig}
          href={explorerTx(sig)}
          target="_blank"
          rel="noreferrer"
          className="block text-xs underline"
        >
          Claimed: view transaction
        </a>
      ))}
      <ErrorText error={error} />
    </div>
  )
}
