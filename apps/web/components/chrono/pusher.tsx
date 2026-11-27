'use client'
// The two buttons under the dial (spec 3.2), in a fan's verb and one unit (culture review string
// 7): "Back CLE · 77%" and "Back MEM · 23%". On mobile a button opens the crown for that side; on
// desktop it picks the side of the crown beside it.
// An empty wallet gets the faucet button the wallet sheet already has; a visitor with no wallet
// gets the buy buttons, and the crown sets the wallet up (R5).
import type { Side } from '@horagon/sdk'
import { DISABLED, SELECTED } from '../../lib/chrono/controls'
import type { PusherMode } from '../../lib/chrono/pusher'
import { percent } from '../../lib/format'
import { sidePrice } from '../../lib/trade-view'
import { FAUCET_BUTTON, WALLET_PREPARING } from '../../lib/wallet-copy'

export function Pusher(p: {
  mode: PusherMode
  home: string
  away: string
  /** The home side's (YES) price. */
  price: number | null
  onPick: (side: Side) => void
  /** Desktop: the side the crown is on. */
  selected?: Side | null
  funding: boolean
  /** The faucet waits for the wallet's key code to load (WalletState.preparing). */
  preparing?: boolean
  onFaucet: () => void
}) {
  const { mode } = p
  if (mode.kind === 'none') return null
  if (mode.kind === 'line') {
    return <p className="text-center font-mono text-13 text-ash-400">{mode.text}</p>
  }
  if (mode.kind === 'faucet') {
    return (
      <button
        type="button"
        disabled={p.funding || p.preparing}
        onClick={() => p.onFaucet()}
        className={`min-h-14 w-full rounded-card border border-lume-300/50 text-15 font-semibold text-lume-300 ${DISABLED}`}
      >
        {p.funding ? 'Requesting…' : p.preparing ? WALLET_PREPARING : FAUCET_BUTTON}
      </button>
    )
  }
  // In the Scorebug's order: away on the left, home on the right (culture review A1).
  const sides = [
    ['away', p.away, 'border-brass-500/60 text-brass-400'],
    ['home', p.home, 'border-lume-300/60 text-lume-300'],
  ] as const
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        {sides.map(([side, team, look]) => (
          <button
            key={side}
            type="button"
            disabled={mode.locked}
            aria-pressed={p.selected === undefined ? undefined : p.selected === side}
            onClick={() => p.onPick(side)}
            className={`min-h-14 rounded-card border-2 font-mono text-15 font-semibold tabular-nums ${SELECTED} ${DISABLED} ${look}`}
          >
            {p.price === null
              ? `Back ${team}`
              : `Back ${team} · ${percent(sidePrice(p.price, side))}`}
          </button>
        ))}
      </div>
      {mode.note && <p className="text-center font-mono text-13 text-amber-400">{mode.note}</p>}
    </div>
  )
}
