'use client'
// The game screen's data (Chronometer spec 4.2, 5.2): the game every 3 s and its history every
// 15 s as before, plus the winner market's state every 60 s for its real start_ts. While a
// result is proposed, the published evidence JSON names the proposed side, so the needle can
// turn toward it. No new endpoint: both are routes the SDK client already has.
import { isHoragonError } from '@horagon/sdk'
import { api } from '../lib/api'
import { winnerOf } from '../lib/chrono/board'
import { proposedOutcome } from '../lib/chrono/evidence'
import { gameDial } from '../lib/chrono/game'
import { pollHealth } from '../lib/chrono/health'
import { useNow } from '../lib/chrono/now'
import { usePoll } from '../lib/use-poll'
import { GameLoading, GameScreen, NoGame } from './chrono/game-screen'
import { GamePositions, MarketBlock } from './chrono/market-block'
import { ErrorText } from './error-text'

const SLOW_POLL_MS = 60_000

export function GameView({ id }: { id: string }) {
  const detail = usePoll(`game:${id}`, () => api.games.get(id))
  const history = usePoll(`history:${id}`, () => api.games.history(id), 15_000)
  const game = detail.data
  const winner = game ? winnerOf(game) : undefined
  const pubkey = winner?.pubkey ?? ''
  const marketState = usePoll(
    pubkey ? `market:${pubkey}` : null,
    () => api.markets.get(pubkey),
    SLOW_POLL_MS,
  )
  const evidence = usePoll(
    winner?.status === 'proposed' ? `evidence:${id}` : null,
    () => api.evidence(id, 'winner'),
    SLOW_POLL_MS,
  )
  const now = useNow()
  const health = pollHealth(detail)

  if (!game) {
    // A malformed id is refused as INVALID_INPUT before the lookup: it names no game either.
    const missing =
      isHoragonError(detail.error) &&
      (detail.error.code === 'NOT_FOUND' || detail.error.code === 'INVALID_INPUT')
    if (missing) return <NoGame />
    return (
      <div className="space-y-3">
        <GameLoading stale={health.stale} />
        <ErrorText error={health.error} />
      </div>
    )
  }

  const proposed = evidence.data ? proposedOutcome(evidence.data.json) : null
  const dial = gameDial(game, winner, marketState.data?.startTs ?? null, proposed, now)
  return (
    <div className="space-y-3">
      <GameScreen
        game={game}
        history={history.data}
        dial={dial}
        now={now}
        stale={health.stale}
        right={
          winner ? (
            <MarketBlock
              key={winner.pubkey}
              game={game}
              market={winner}
              dial={dial}
              now={now}
              stale={health.stale}
              onMarketStale={detail.refresh}
            />
          ) : (
            <GamePositions game={game} canSell={false} onSell={() => {}} />
          )
        }
      />
      <ErrorText error={health.error} />
    </div>
  )
}
