// The night chip (R7): the NBA nights this wallet made calls on, "Night 2 of 3", linking My
// Game-day. A count of nights, never a streak, and it says it has no value. Absent at 0. The
// header's chip look, as YourHour (light branding review §4.8): a rule edge and ink words.
import Link from 'next/link'
import { chipLabel, streakLabel } from '../../lib/me'

export function NightChip(p: { nights: number; className?: string }) {
  const label = streakLabel(p.nights)
  if (label === null) return null
  return (
    <Link
      href="/me"
      aria-label={chipLabel(p.nights)}
      className={`min-h-11 shrink-0 items-center whitespace-nowrap rounded-full border border-rule px-3 font-mono text-13 text-ink tabular-nums ${p.className ?? 'inline-flex'}`}
    >
      {label}
    </Link>
  )
}
