// The first lines on `/` (R5, first-screen spec C1, C2b, C3, C4): what Horagon is and that it is
// play money, then the three steps of a first trade folded under "How it works" (at 375 the
// mechanism line follows them; from sm up the proof rail shows it), small enough that the first
// game row stays above the fold at 375x812. The line claims a price move ("Prices move with every
// run.") only when the page says a moved market is on screen (`moved`, see heroMoved).
import type { ReactNode } from 'react'
import { MECHANISM_LINE } from '../proof-rail'

export const HERO_LINE = 'Call the winner while the NBA game is on. Open until the final buzzer.'
export const HERO_LINE_MOVED =
  'Call the winner while the NBA game is on. Prices move with every run. Open until the final buzzer.'
export const HERO_SUB = 'Play money on Solana devnet. Free, no sign-up.'
export const HERO_STEPS = [
  'Pick a game.',
  'Back a team: each share pays 1 mUSDC if it wins.',
  'Watch the price move with the game; claim after the result.',
] as const

/**
 * `second`: the hero's second line on a rest day, the Practice strip (R8). `moved`: a moved market
 * is on screen, so the H1 may say prices move (C2b).
 */
export function Hero({ second, moved = false }: { second?: ReactNode; moved?: boolean } = {}) {
  return (
    <section aria-labelledby="hero-title" className="mb-2 space-y-2" data-hero>
      <h1
        id="hero-title"
        className="text-24 leading-[1.875rem] font-medium text-ivory-100 lg:text-[2rem] lg:leading-10"
      >
        {moved ? HERO_LINE_MOVED : HERO_LINE}
      </h1>
      {second}
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <p className="flex items-center gap-2 text-14 font-medium text-ivory-100">
          <span aria-hidden="true" className="h-px w-3.5 flex-none bg-brass-700" />
          {HERO_SUB}
        </p>
        <details className="group open:basis-full" data-how>
          <summary className="flex min-h-11 w-fit cursor-pointer list-none items-center gap-1.5 text-13 text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true" className="group-open:rotate-90">
              ▸
            </span>
            How it works
          </summary>
          <ol className="grid gap-1 pb-1 text-13 text-ink-muted sm:grid-cols-3 sm:gap-4">
            {HERO_STEPS.map((step, i) => (
              <li key={step} className="flex gap-2">
                <span className="font-mono text-brass-500">{i + 1}.</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
          <p className="pb-1 text-13 text-ink-muted sm:hidden" data-how-mechanism>
            {MECHANISM_LINE}
          </p>
        </details>
      </div>
    </section>
  )
}
