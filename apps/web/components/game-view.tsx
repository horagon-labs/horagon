'use client'
import { type GameDetail, isHoragonError } from '@horagon/sdk'
import { api } from '../lib/api'
import { gameClock, percent } from '../lib/format'
import { usePoll } from '../lib/use-poll'
import { Countdown } from './countdown'
import { ErrorText } from './error-text'
import { Positions } from './positions'
import { PriceChart } from './price-chart'
import { ResolutionPanel } from './resolution-panel'
import { TradePanel } from './trade-panel'

function Scoreboard({ game }: { game: GameDetail }) {
  const started = game.status !== 'scheduled'
  return (
    <section className="flex items-center justify-between rounded-xl bg-zinc-900 p-4 text-white">
      <div className="text-center">
        <p className="text-sm text-zinc-400">Away</p>
        <p className="text-xl font-bold">{game.away}</p>
        <p className="text-3xl font-bold">{started ? game.awayScore : '–'}</p>
      </div>
      <div className="text-center">
        <p className={game.status === 'live' ? 'font-semibold text-red-400' : 'text-zinc-300'}>
          {gameClock(game)}
        </p>
        <p className="text-xs text-zinc-400">
          Model: {game.home} {percent(game.modelProb)}
        </p>
      </div>
      <div className="text-center">
        <p className="text-sm text-zinc-400">Home</p>
        <p className="text-xl font-bold">{game.home}</p>
        <p className="text-3xl font-bold">{started ? game.homeScore : '–'}</p>
      </div>
    </section>
  )
}

export function GameView({ id }: { id: string }) {
  const detail = usePoll(`game:${id}`, () => api.games.get(id))
  const history = usePoll(`history:${id}`, () => api.games.history(id), 15_000)
  const game = detail.data

  if (!game) {
    // A malformed id is refused as INVALID_INPUT before the lookup: it names no game either.
    const missing =
      isHoragonError(detail.error) &&
      (detail.error.code === 'NOT_FOUND' || detail.error.code === 'INVALID_INPUT')
    if (missing) return <p className="text-zinc-500">This game does not exist.</p>
    return detail.error ? (
      <ErrorText error={detail.error} />
    ) : (
      <p className="text-zinc-500">Loading game…</p>
    )
  }
  const winner = game.markets.find((m) => m.kind === 'winner')
  return (
    <div className="space-y-6">
      <Scoreboard game={game} />
      {winner ? (
        <>
          <PriceChart
            history={history.data}
            market={winner.pubkey}
            home={game.home}
            away={game.away}
          />
          {winner.status === 'open' && (
            <Countdown endTs={winner.endTs} chainTs={winner.priceTs ?? 0} />
          )}
          <TradePanel game={game} market={winner} />
        </>
      ) : (
        <p className="text-zinc-500">The market opens 60 minutes before tip-off.</p>
      )}
      <section>
        <h2 className="mb-1 font-semibold">Your position</h2>
        <Positions gameId={game.id} teams={{ home: game.home, away: game.away }} />
      </section>
      <details>
        <summary className="cursor-pointer font-semibold">Market rules</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {game.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </details>
      <ResolutionPanel game={game} />
    </div>
  )
}
