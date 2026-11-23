'use client'
// Positions of the wallet (all, or one game's). The Claim all run is the wallet's
// (WalletProvider): every copy of this list shows the same run, and one run at a time.
import Link from 'next/link'
import { explorerTx, sideLabel, usdc } from '../lib/format'
import { ErrorText } from './error-text'
import { useWallet } from './wallet'

export function Positions({
  gameId,
  teams,
}: {
  gameId?: string
  /** The game's teams, when this list is one game's: the portfolio carries no team names. */
  teams?: { home: string; away: string }
}) {
  const { portfolio, startClaims, claiming, claimed, claimError } = useWallet()

  const rows = (portfolio?.positions ?? []).filter((p) => !gameId || p.gameId === gameId)
  const claimable = rows.some((p) => p.claimable)

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
                  {sideLabel(p.side, teams)} · {usdc(p.shares)} shares
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
      {(claimable || claiming) && (
        <button
          type="button"
          disabled={claiming}
          onClick={startClaims}
          className="w-full rounded-lg bg-emerald-600 py-2 font-semibold text-white disabled:opacity-50"
        >
          {claiming ? 'Claiming…' : 'Claim all'}
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
      <ErrorText error={claimError} />
    </div>
  )
}
