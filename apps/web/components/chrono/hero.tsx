// The first lines on `/` (R5): what Horagon is, that it is play money, and the three steps of a
// first trade, small enough that the first game row stays above the fold at 375x812.
import type { ReactNode } from 'react'
export const HERO_LINE =
  'Call NBA games live. Prices move with every run. Open until the final buzzer.'
export const HERO_SUB = 'Play money on Solana devnet.'
export const HERO_STEPS = [
  "Pick tonight's game.",
  'Back a team: each share pays 1 mUSDC if it wins.',
  'Watch the price move with the game; claim after the result.',
] as const

/** `second`: the hero's second line on a rest day, the Practice strip (R8). */
export function Hero({ second }: { second?: ReactNode } = {}) {
  return (
    <section aria-labelledby="hero-title" className="mb-5 space-y-2" data-hero>
      <h1
        id="hero-title"
        className="max-w-2xl text-19 font-medium text-ivory-100 sm:text-24 sm:leading-8"
      >
        {HERO_LINE}
      </h1>
      {second}
      <p className="flex items-center gap-2 text-14 font-medium text-ivory-100">
        <span aria-hidden="true" className="h-px w-3.5 flex-none bg-brass-700" />
        {HERO_SUB}
      </p>
      <ol className="grid gap-1 text-13 text-ash-400 sm:grid-cols-3 sm:gap-4">
        {HERO_STEPS.map((step, i) => (
          <li key={step} className="flex gap-2">
            <span className="font-mono text-brass-500">{i + 1}.</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
