// The Practice strip on `/` (R8): one server-rendered line, a link, no script. Under the board,
// or the hero's second line on a rest day. It is never part of the Night dial, the Tonight list
// or the calendar: those list NBA games only.
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
      <Link href={strip.href} className="underline underline-offset-4">
        {strip.text}
      </Link>
    </p>
  )
}
