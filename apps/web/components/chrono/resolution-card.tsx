// How the winner market resolved (spec 3.2): the milestones, the evidence link with its sha256,
// and the market account, with the words resolution-panel.tsx has always used.
import type { GameDetail } from '@horagon/sdk'
import { milestones } from '../../lib/chrono/resolution'
import { explorerAddress, explorerTx } from '../../lib/format'

const DOT = { done: 'bg-lume-300', now: 'bg-amber-400', next: 'bg-line' } as const

export function ResolutionCard({ game }: { game: GameDetail }) {
  const r = game.resolutions.find((x) => x.kind === 'winner')
  if (!r) return null
  return (
    <section className="space-y-3 rounded-card border border-brass-500/15 p-4 text-13">
      <h2 className="text-11 uppercase tracking-[0.3em] text-brass-500">Resolution</h2>
      <p>
        Winner market: <span className="font-medium text-ivory-100">{r.status}</span>
        {r.outcome && ` · ${r.outcome === 'yes' ? game.home : game.away} won`}
      </p>
      <ol className="space-y-1">
        {milestones(r).map((m) => (
          <li key={m.label} className="flex items-center gap-2" data-mark={m.mark}>
            <span aria-hidden="true" className={`size-2 rounded-full ${DOT[m.mark]}`} />
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
              <span className={m.mark === 'next' ? 'text-ash-400' : 'text-ivory-100'}>
                {m.label}
              </span>
            )}
          </li>
        ))}
      </ol>
      {r.externalLp && (
        <p className="text-amber-400">
          Someone besides Horagon also provides liquidity here. A halt withdraws only Horagon's
          share, so this market can still trade after a halt.
        </p>
      )}
      {r.evidenceUrl && (
        <p>
          <a
            href={r.evidenceUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center underline"
          >
            Evidence JSON
          </a>
          {r.evidenceHash && (
            <span className="ml-2 break-all font-mono text-11 text-ash-400">
              sha256 {r.evidenceHash}
            </span>
          )}
        </p>
      )}
      <p className="flex flex-wrap gap-x-3">
        <a
          href={explorerAddress(r.market)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-11 items-center underline"
        >
          Market account
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
            Halted
          </a>
        )}
      </p>
    </section>
  )
}
