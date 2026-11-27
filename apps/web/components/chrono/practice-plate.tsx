// The PRACTICE plate and the Practice note (R8). The plate is a story plate: a pill with a brass
// hairline and ink caps, so a replay never passes for a real night. The note says string 26, the
// recording, and who else trades it (left out while that is not known). No hooks: it renders on
// the server as well as in the game view.
import type { GameDetail, PracticeResponse } from '@horagon/sdk'
import { counterpartyLine, PRACTICE_LINE, recordedLine } from '../../lib/chrono/practice'

/** The story-plate look (A2): pill, 1 px brass hairline, ink caps 12/600, tracking 0.16em. */
export const PLATE =
  'inline-flex min-h-7 items-center rounded-full border border-brass px-3 text-12 font-semibold uppercase tracking-[0.16em] text-ink'

export function PracticePlate() {
  return (
    <span className={PLATE} data-practice-plate>
      Practice
    </span>
  )
}

export function PracticeNote(p: {
  game: Pick<GameDetail, 'id' | 'home' | 'away'>
  counterparty: PracticeResponse['counterparty'] | null
}) {
  return (
    <div className="space-y-1 text-center text-13 text-ink-muted" data-practice-note>
      <p className="font-medium text-ink">{PRACTICE_LINE}</p>
      <p className="font-mono text-12">{recordedLine(p.game)}</p>
      {p.counterparty && (
        <p data-counterparty={p.counterparty}>{counterpartyLine(p.counterparty)}</p>
      )}
    </div>
  )
}
