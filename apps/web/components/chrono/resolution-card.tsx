// How the winner market resolved (spec 3.2): the milestones, the evidence link with its sha256,
// /verify for the market, and the market account. The status line comes from the dial's state
// (R5), so it never says "open" next to a dial that says trading closed; while a result is
// proposed it counts the challenge window down on the screen's clock (R6 part B).
import type { GameDetail } from '@horagon/sdk'
import { externalLpNote, haltLinkLabel, resolutionStatus } from '../../lib/chrono/copy'
import { milestones } from '../../lib/chrono/resolution'
import type { DialState } from '../../lib/chrono/state'
import { explorerAddress, explorerTx } from '../../lib/format'

// The milestones told apart by shape, not hue (review §4.7, u3 §3.2): done is a filled ink dot,
// now an empty 2 px ink ring a size up, next an empty 1 px rule ring.
const DOT = {
  done: 'size-2 rounded-full bg-ivory-100',
  now: 'size-2.5 rounded-full border-2 border-ivory-100',
  next: 'size-2 rounded-full border border-line',
} as const
const WORDS = {
  done: 'text-ivory-100',
  now: 'font-semibold text-ivory-100',
  next: 'text-ash-400',
} as const

/** `now`: unix seconds from the game screen's useNow, so the challenge countdown ticks. */
export function ResolutionCard({
  game,
  state,
  now,
}: {
  game: GameDetail
  state: DialState
  now: number
}) {
  const r = game.resolutions.find((x) => x.kind === 'winner')
  if (!r) return null
  return (
    <section className="space-y-3 rounded-card border border-rule-faint p-4 text-13">
      <h2 className="text-12 uppercase tracking-[0.3em] text-brass-500">Resolution</h2>
      <p className="font-medium text-ivory-100" data-status>
        {resolutionStatus(state, game, r.outcome, { challengeEndsAt: r.challengeEndsAt, now })}
      </p>
      <ol className="space-y-1">
        {milestones(r, now).map((m) => (
          <li key={m.label} className="flex items-center gap-2" data-mark={m.mark}>
            <span aria-hidden="true" className={DOT[m.mark]} />
            {m.sig ? (
              <a
                href={explorerTx(m.sig)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center underline"
              >
                {m.label}
              </a>
            ) : (
              <span className={WORDS[m.mark]}>{m.label}</span>
            )}
          </li>
        ))}
      </ol>
      {r.externalLp && <p className="text-amber-400">{externalLpNote(game)}</p>}
      {r.evidenceUrl && (
        <p>
          <a
            href={r.evidenceUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center underline"
          >
            Result evidence (JSON)
          </a>
          {r.evidenceHash && (
            <span className="ml-2 break-all font-mono text-12 text-ink-muted">
              sha256 {r.evidenceHash}
            </span>
          )}
        </p>
      )}
      {r.evidenceHash && (
        <p>
          {/* A plain link: the /verify code loads only when it is opened. */}
          <a href={`/verify/${r.market}`} className="inline-flex min-h-11 items-center underline">
            Verify this result
          </a>
        </p>
      )}
      <p className="flex flex-wrap gap-x-3">
        <a
          href={explorerAddress(r.market)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 items-center underline"
        >
          Market on Solana Explorer
        </a>
        {r.createSig && (
          <a
            href={explorerTx(r.createSig)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center underline"
          >
            Created
          </a>
        )}
        {r.haltSig && (
          <a
            href={explorerTx(r.haltSig)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center underline"
          >
            {haltLinkLabel(game)}
          </a>
        )}
      </p>
    </section>
  )
}
