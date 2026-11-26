'use client'
// Your position in this game (spec 3.2): paid, worth now and what it pays if that team wins,
// with Sell. Claim all is a HoldButton running the wallet's own startClaims, so a claim is
// still the whole wallet's (one run at a time, every copy shows it).
import type { PositionsResponse, Side } from '@horagon/sdk'
import { parseAmount } from '@horagon/sdk/amount'
import { explorerTx, usdc } from '../../lib/format'
import { WALLET_PREPARING } from '../../lib/wallet-copy'
import { ErrorText } from '../error-text'
import { HoldButton } from './hold-button'

export interface PositionCardProps {
  gameId: string
  teams: { home: string; away: string }
  portfolio: PositionsResponse | undefined
  /** The market still trades: Sell opens the crown in sell mode for that side. */
  canSell: boolean
  onSell: (side: Side) => void
  claiming: boolean
  /** Claim all waits for the wallet's key code to load (WalletState.preparing). */
  preparing?: boolean
  claimed: string[]
  claimError: unknown
  onClaim: () => void
}

export function PositionCard(p: PositionCardProps) {
  const rows = (p.portfolio?.positions ?? []).filter(
    (x) => x.gameId === p.gameId && x.kind === 'winner' && parseAmount(x.shares) > 0n,
  )
  const claimable = rows.some((x) => x.claimable)
  return (
    <section className="space-y-3 rounded-card border border-brass-500/15 p-4">
      <h2 className="text-12 uppercase tracking-[0.3em] text-brass-500">Your position</h2>
      {rows.length === 0 ? (
        <p className="text-13 text-ash-400">No positions yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((x) => {
            const team = p.teams[x.side]
            const down = x.pnlUsdc.startsWith('-')
            return (
              <li key={`${x.market}-${x.side}`} className="flex items-center gap-3 py-2">
                {/* Yours, one live ◆ for either side: teams have no colour (review §3.2). */}
                <span aria-hidden="true" className="text-live">
                  ◆
                </span>
                <div className="min-w-0 flex-1 font-mono text-13 tabular-nums">
                  <p className="font-sans text-15 text-ivory-100">
                    {team} · {usdc(x.shares)} shares
                  </p>
                  <p className="text-ash-400">
                    paid {usdc(x.costUsdc)} · worth {usdc(x.valueUsdc)}{' '}
                    <span className={down ? 'text-red-400' : 'text-lume-300'}>
                      ({down ? '' : '+'}
                      {usdc(x.pnlUsdc)})
                    </span>
                  </p>
                  <p className="text-ash-400">
                    {x.outcome === null
                      ? `pays ${usdc(x.shares)} mUSDC if ${team} wins`
                      : `${team} ${(x.side === 'home') === (x.outcome === 'yes') ? 'won' : 'lost'}`}
                  </p>
                </div>
                {p.canSell && (
                  <button
                    type="button"
                    onClick={() => p.onSell(x.side)}
                    className="min-h-11 rounded-card border border-line px-4 text-13 text-ivory-100"
                  >
                    Sell
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {(claimable || p.claiming) && (
        <HoldButton
          label={p.claiming ? 'Claiming…' : p.preparing ? WALLET_PREPARING : 'Claim all'}
          pending={p.claiming || p.preparing}
          onConfirm={p.onClaim}
        />
      )}
      {p.claimed.map((sig) => (
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
      <ErrorText error={p.claimError} />
    </section>
  )
}
