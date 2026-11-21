import type { GameDetail } from '@horagon/sdk'
import { explorerAddress, explorerTx } from '../lib/format'

const STEPS = [
  ['createSig', 'Created'],
  ['haltSig', 'Halted'],
  ['proposeSig', 'Result proposed'],
  ['finalizeSig', 'Finalized'],
  ['recycleSig', 'Recycled'],
] as const

export function ResolutionPanel({ game }: { game: GameDetail }) {
  if (game.resolutions.length === 0) return null
  return (
    <section className="space-y-3">
      <h2 className="font-semibold">Resolution</h2>
      {game.resolutions.map((r) => (
        <div key={r.market} className="space-y-1 text-sm">
          <p>
            {r.kind === 'winner' ? 'Winner' : 'Second half'} market:{' '}
            <span className="font-medium">{r.status}</span>
            {r.outcome && ` · ${r.outcome === 'yes' ? game.home : game.away} won`}
          </p>
          {r.externalLp && (
            <p className="text-amber-600">
              Someone besides Horagon also provides liquidity here. A halt withdraws only Horagon's
              share, so this market can still trade after a halt.
            </p>
          )}
          <a
            href={explorerAddress(r.market)}
            target="_blank"
            rel="noreferrer"
            className="block underline"
          >
            Market account
          </a>
          {r.evidenceUrl && (
            <p>
              <a href={r.evidenceUrl} target="_blank" rel="noreferrer" className="underline">
                Evidence JSON
              </a>
              {r.evidenceHash && (
                <span className="ml-2 break-all font-mono text-xs text-zinc-500">
                  sha256 {r.evidenceHash}
                </span>
              )}
            </p>
          )}
          <ul className="flex flex-wrap gap-x-3">
            {STEPS.map(([key, label]) => {
              const sig = r[key]
              return sig ? (
                <li key={key}>
                  <a href={explorerTx(sig)} target="_blank" rel="noreferrer" className="underline">
                    {label}
                  </a>
                </li>
              ) : null
            })}
          </ul>
        </div>
      ))}
    </section>
  )
}
