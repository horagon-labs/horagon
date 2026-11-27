'use client'
// The game screen's data (Chronometer spec 4.2, 5.2): the game every 3 s and its history every
// 15 s as before, plus the winner market's state every 60 s for its real start_ts. While a
// result is proposed, the published evidence JSON names the proposed side, so the needle can
// turn toward it. No new endpoint: both are routes the SDK client already has. The server's first
// frame (R5, lib/server/initial.ts) draws the game, its real price included, until the first
// poll answers; without it the page opens on a dial with no needle.
import type { PracticeResponse } from '@horagon/sdk'
import { isHoragonError } from '@horagon/sdk/errors'
import { api } from '../lib/api'
import { winnerOf } from '../lib/chrono/board'
import { proposedOutcome } from '../lib/chrono/evidence'
import { gameDial } from '../lib/chrono/game'
import { pollHealth } from '../lib/chrono/health'
import { useNow } from '../lib/chrono/now'
import { isPractice } from '../lib/chrono/practice'
import { fullTitle, gameMeta } from '../lib/meta'
import type { InitialGame } from '../lib/server/initial'
import { usePoll } from '../lib/use-poll'
import { GameLoading, GameScreen, NoGame } from './chrono/game-screen'
import { GamePositions, MarketBlock } from './chrono/market-block'
import { PracticeNote, PracticePlate } from './chrono/practice-plate'
import { ErrorText } from './error-text'
import { ShareButton } from './share-button'
import { useWallet } from './wallet'

const SLOW_POLL_MS = 60_000

export function GameView({
  id,
  initial,
  counterparty = null,
}: {
  id: string
  initial?: InitialGame
  /** A Practice game's other trader, from GET /practice on the server; null when not known. */
  counterparty?: PracticeResponse['counterparty'] | null
}) {
  const detail = usePoll(`game:${id}`, () => api.games.get(id))
  const { address, portfolio } = useWallet()
  const history = usePoll(`history:${id}`, () => api.games.history(id), 15_000)
  const game = detail.data ?? initial?.game
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
  // 0 while hydrating (lib/chrono/now.ts): the server's clock, so both renders match.
  const now = useNow() || (initial?.now ?? 0)
  const health = pollHealth(detail)

  if (!game) {
    // A malformed id is refused as INVALID_INPUT before the lookup: it names no game either.
    const missing =
      (isHoragonError(detail.error) &&
        (detail.error.code === 'NOT_FOUND' || detail.error.code === 'INVALID_INPUT')) ||
      initial?.missing === true
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
  const meta = gameMeta(game, now)
  // A Practice replay (R8) wears its plate where the share button sits: it is never shared.
  const practice = isPractice(game)
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <h1 className="pt-3 text-13 font-medium uppercase tracking-[0.2em] text-brass-500">
          {game.away} @ {game.home}
        </h1>
        {practice ? (
          <PracticePlate />
        ) : (
          <ShareButton title={fullTitle(meta.title)} text={meta.title} />
        )}
      </div>
      {practice && <PracticeNote game={game} counterparty={counterparty} />}
      <GameScreen
        game={game}
        history={history.data}
        dial={dial}
        now={now}
        stale={health.stale}
        positions={portfolio?.wallet === address ? portfolio?.positions : undefined}
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
