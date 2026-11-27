// "Last night on the dial" (R10, culture A4): the morning after, on /. A server component with no
// hooks and no client module of its own, so it ships no script. Mono numbers; no live colour,
// since nothing here is an open market. The strip is the idle face when the story card has no
// data; under a story card, `NightRowList` lists the night's other games (first-screen W3).
import Link from 'next/link'
import {
  type LastNight,
  type LastNightRow,
  lastNightHeader,
  lastNightRowText,
} from '../lib/server/last-night'

// Ink among muted words is under 3:1 against them, so the link is underlined too (review §3.3).
const LINK = 'inline-flex min-h-11 items-center text-13 text-ink underline underline-offset-4'

/** The A4 rows (C14): UPSET plate, mono numbers, wrapping between the parts only. */
export function NightRowList({ rows }: { rows: readonly LastNightRow[] }) {
  return (
    <ul className="space-y-1.5 border-t border-rule pt-2">
      {rows.map((r) => (
        <li key={r.id} className="font-mono text-13 text-ink tabular-nums">
          {r.upset && (
            <span className="mr-2 inline-block rounded-sm border border-ink px-1 font-sans text-12 font-semibold uppercase leading-4 tracking-wide">
              UPSET
            </span>
          )}
          {/* A narrow screen wraps between the parts, never inside one. */}
          {lastNightRowText(r)
            .split(' · ')
            .map((part, i) => (
              <span key={part}>
                {i > 0 && ' · '}
                <span className="whitespace-nowrap">{part}</span>
              </span>
            ))}
        </li>
      ))}
    </ul>
  )
}

export function LastNightStrip({
  night,
  now,
  className = 'mt-8',
}: {
  night: LastNight
  now: number
  className?: string
}) {
  return (
    <section aria-labelledby="last-night" className={`space-y-2 ${className}`} data-last-night>
      <h2 id="last-night" className="text-13 font-medium uppercase tracking-[0.2em] text-ink">
        {lastNightHeader(night, now)}
      </h2>
      <NightRowList rows={night.rows} />
      <Link href="/study" className={LINK}>
        How the model is checked
      </Link>
    </section>
  )
}
