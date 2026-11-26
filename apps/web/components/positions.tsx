'use client'
// Positions of the wallet (all, or one game's). The Claim all run is the wallet's
// (WalletProvider): every copy of this list shows the same run, and one run at a time.
import Link from 'next/link'
import { positionStatus } from '../lib/chrono/copy'
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
        <p className="text-13 text-ash-400">No positions yet.</p>
      ) : (
        <ul className="divide-y divide-line text-13">
          {rows.map((p) => (
            <li key={`${p.market}-${p.side}`} className="flex items-center justify-between py-2">
              <div>
                <Link
                  href={`/game/${p.gameId}`}
                  className="inline-flex min-h-11 items-center font-medium text-ivory-100 underline-offset-2 hover:underline"
                >
                  {sideLabel(p.side, teams)} · {usdc(p.shares)} shares
                </Link>
                <p className="font-mono text-ash-400 tabular-nums">
                  cost {usdc(p.costUsdc)} · value {usdc(p.valueUsdc)} ·{' '}
                  {positionStatus(p.marketStatus)}
                </p>
              </div>
              <span
                className={`font-mono tabular-nums ${p.pnlUsdc.startsWith('-') ? 'text-red-400' : 'text-lume-300'}`}
              >
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
          className="min-h-11 w-full rounded-card bg-lume-300 py-2 font-semibold text-enamel-950 disabled:opacity-50"
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
          className="flex min-h-11 items-center text-12 text-brass-400 underline"
        >
          Claimed: view transaction
        </a>
      ))}
      <ErrorText error={claimError} />
    </div>
  )
}
