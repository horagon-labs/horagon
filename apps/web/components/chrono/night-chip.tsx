// The night chip (R7): the NBA nights this wallet made calls on, "Night 2 of 3", linking My
// Game-day. A count of nights, never a streak, and it says it has no value. Absent at 0.
import Link from 'next/link'
import { chipLabel, streakLabel } from '../../lib/me'

export function NightChip(p: { nights: number; className?: string }) {
  const label = streakLabel(p.nights)
  if (label === null) return null
  return (
    <Link
      href="/me"
      aria-label={chipLabel(p.nights)}
      className={`min-h-11 items-center rounded-full border border-brass-500/40 px-3 font-mono text-13 text-brass-400 tabular-nums ${p.className ?? 'inline-flex'}`}
    >
      {label}
    </Link>
  )
}
