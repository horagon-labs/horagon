// The scorebug (spec 3.2): the score in mono, quarter and game clock with a live dot, the model
// with what it is (R5), and the newest scoring run, "CLE on an 8–0 run · price 74% → 77% in 2 min".
import type { Game } from '@horagon/sdk'
import { MODEL_HINT } from '../../lib/chrono/copy'
import { type Run, runLine } from '../../lib/chrono/runs'
import { etClock } from '../../lib/chrono/time'
import { gameClock, percent } from '../../lib/format'

function Team(p: { side: string; name: string; score: number | null }) {
  return (
    <div className="min-w-16 text-center">
      <p className="text-12 uppercase tracking-[0.2em] text-ash-400">{p.side}</p>
      <p className="text-15 font-semibold text-ivory-100">{p.name}</p>
      <p className="font-mono text-40 text-ivory-100 tabular-nums">{p.score ?? '–'}</p>
    </div>
  )
}

export function Scorebug({ game, run }: { game: Game; run: Run | null }) {
  const started = game.status !== 'scheduled'
  const tip = Math.floor(Date.parse(game.scheduledTipoff) / 1000)
  return (
    <section className="rounded-card border border-rule-faint bg-enamel-900 p-4">
      <div className="flex items-center justify-between gap-2">
        <Team side="Away" name={game.away} score={started ? game.awayScore : null} />
        <div className="text-center">
          <p className="flex items-center justify-center gap-1.5 font-mono text-13 text-ivory-100">
            {game.status === 'live' && (
              <span className="size-2 rounded-full bg-lume-300" data-live />
            )}
            {started ? gameClock(game) : `tip-off ${etClock(tip)}`}
          </p>
          <p className="text-13 text-brass-500" title={MODEL_HINT}>
            Model: {game.home} {percent(game.modelProb)}
          </p>
        </div>
        <Team side="Home" name={game.home} score={started ? game.homeScore : null} />
      </div>
      {run && (
        <p className="mt-2 text-center font-mono text-12 text-ash-400" data-run>
          {runLine(run, game)}
        </p>
      )}
    </section>
  )
}
