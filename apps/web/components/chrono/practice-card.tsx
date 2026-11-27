// The Practice card (first-screen S6, W8, C24): while a Practice run is on the court and no NBA
// market is open, it leads the idle face below lg and tops the list's column from lg. R8's words
// only: the PRACTICE plate with "Practice game live · MEM @ CLE · Replay", string 26, the
// recording with the score and price under it (a 15 s text island, W8b) beside a filled ink "Play
// along", then who else trades. A server component with a plain link (next/link from a server
// component added a client chunk to `/`, slice 2), no style attribute or script (R9 CSP), and no
// Live blue: on `/` blue means an NBA market is open (§4). Between runs the idle foot keeps R8's
// one line.
import type { Game, PracticeResponse } from '@horagon/sdk'
import {
  counterpartyLine,
  PLAY_ALONG,
  PRACTICE_LINE,
  practiceLiveLine,
  recordedLine,
} from '../../lib/chrono/practice'
import { PracticeLive } from './practice-live'
import { PracticePlate } from './practice-plate'

export function PracticeCard({
  run,
  counterparty,
}: {
  /** The run on the court (lib/chrono/practice.ts practiceLive). */
  run: Game
  counterparty: PracticeResponse['counterparty']
}) {
  return (
    <section aria-labelledby="practice-title" className="space-y-1.5" data-practice-card>
      {/* The plate flows with the words, as on the story card: line 1 wraps beside it at 375. */}
      <h2 id="practice-title" className="text-15 font-medium text-ink">
        <span className="mr-1">
          <PracticePlate />
        </span>{' '}
        <span>{practiceLiveLine(run)}</span>
      </h2>
      <p className="text-13 text-ink">{PRACTICE_LINE}</p>
      {/* The recording, then its score and price, beside the button: one row, so at 375 the card
          and the compact story keep the first board row above the fold in S2 and S5 (§9). */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-12 text-ink-muted">{recordedLine(run)}</p>
          <PracticeLive run={run} />
        </div>
        {/* A plain <a>: the replay's game page loads as its own document. */}
        <a
          href={`/game/${run.id}`}
          className="inline-flex min-h-11 shrink-0 items-center rounded-card bg-ink px-4 text-13 font-semibold text-surface"
        >
          {PLAY_ALONG}
        </a>
      </div>
      <p className="text-12 text-ink-muted" data-counterparty={counterparty}>
        {counterpartyLine(counterparty)}
      </p>
    </section>
  )
}
