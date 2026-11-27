// "Last night on the dial" (R10, culture A4): the morning after, under the board on /. A server
// component with no hooks and no client module of its own, so it ships no script. Mono numbers;
// no live colour, since nothing here is an open market.
import Link from 'next/link'
import { type LastNight, lastNightHeader, lastNightRowText } from '../lib/server/last-night'

// Ink among muted words is under 3:1 against them, so the link is underlined too (review §3.3).
const LINK = 'inline-flex min-h-11 items-center text-13 text-ink underline underline-offset-4'

export function LastNightStrip({ night }: { night: LastNight }) {
  return (
    <section aria-labelledby="last-night" className="mt-8 space-y-2" data-last-night>
      <h2 id="last-night" className="text-13 font-medium uppercase tracking-[0.2em] text-ink">
        {lastNightHeader(night)}
      </h2>
      <ul className="space-y-1.5 border-t border-rule pt-2">
        {night.rows.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-baseline gap-x-2 font-mono text-13 text-ink tabular-nums"
          >
            {r.upset && (
              <span className="rounded-sm border border-ink px-1 font-sans text-12 font-semibold uppercase leading-4 tracking-wide">
                UPSET
              </span>
            )}
            <span>{lastNightRowText(r)}</span>
          </li>
        ))}
      </ul>
      <Link href="/study" className={LINK}>
        How the model is checked
      </Link>
    </section>
  )
}
