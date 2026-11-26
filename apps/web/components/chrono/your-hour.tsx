'use client'
// The game-day chip on the header (spec 3.2): open positions and what they are worth now,
// "◆ 3 · 142.50". The wallet button shows it only once a wallet exists.
import type { PositionsResponse } from '@horagon/sdk'
import { yourHour } from '../../lib/chrono/board'

export function YourHour(p: {
  portfolio: PositionsResponse | undefined
  onOpen: () => void
  className?: string
}) {
  const hour = yourHour(p.portfolio)
  if (!hour) return null
  const noun = hour.count === 1 ? 'position' : 'positions'
  return (
    <button
      type="button"
      onClick={p.onOpen}
      aria-label={`${hour.count} open ${noun}, worth ${hour.value} mUSDC`}
      className={`min-h-11 shrink-0 whitespace-nowrap rounded-full border border-lume-300/40 px-3 font-mono text-13 text-lume-300 tabular-nums ${p.className ?? ''}`.trim()}
    >
      ◆ {hour.count} · {hour.value}
    </button>
  )
}
