// The Practice strip on `/` (R8): one server-rendered line, a link, no script. In the idle face's
// foot between runs, and under the compact story once a market is open (first-screen S6). It is
// never part of the Night dial, the Tonight list or the calendar: those list NBA games only.
import Link from 'next/link'
import type { PracticeStripLine } from '../../lib/chrono/practice'
import { PracticePlate } from './practice-plate'

export function PracticeStrip({
  strip,
  className = '',
}: {
  strip: PracticeStripLine | null
  className?: string
}) {
  if (!strip) return null
  return (
    <p
      className={`flex flex-wrap items-center gap-2 text-14 text-ink ${className}`}
      data-practice-strip
    >
      <PracticePlate />
      {/* min-h-11: a 44 px tap target inside the 14 px line (first-screen §9). */}
      <Link
        href={strip.href}
        className="inline-flex min-h-11 items-center underline underline-offset-4"
      >
        {strip.text}
      </Link>
    </p>
  )
}
