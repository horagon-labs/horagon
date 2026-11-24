'use client'
// The game screen (spec 4.2). One column on mobile: Scorebug, the big Dial, Tape, then the
// Pusher, PositionCard and ResolutionCard. From 1024 px the same two halves sit side by side:
// Scorebug, Dial and Tape on the left, the crown, PositionCard and ResolutionCard on the right.
import type { GameDetail, GameHistory } from '@horagon/sdk'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { winnerOf } from '../../lib/chrono/board'
import type { GameDial } from '../../lib/chrono/game'
import { findRuns, latestRun } from '../../lib/chrono/runs'
import { Dial } from './dial'
import { runKeyOf, stateLine } from './dial-look'
import { ResolutionCard } from './resolution-card'
import { Scorebug } from './scorebug'
import { Tape } from './tape'

export interface GameScreenProps {
  game: GameDetail
  history: GameHistory | undefined
  dial: GameDial
  /** Unix seconds from useNow. */
  now: number
  /** The game poll is failing: the thin red line and "Reconnecting…" (spec 4.4). */
  stale: boolean
  /** The Pusher, the crown and the PositionCard (MarketBlock), or the positions alone. */
  right: ReactNode
}

/** The failing-poll line (spec 4.4), on the screen, the loading face and the crown. */
export function Reconnecting({ stale }: { stale: boolean }) {
  return stale ? (
    <p role="status" className="text-center font-mono text-11 text-red-400">
      Reconnecting…
    </p>
  ) : null
}

export function GameScreen(p: GameScreenProps) {
  const { game, dial } = p
  const winner = winnerOf(game)
  const run = p.history && winner ? latestRun(findRuns(p.history, winner.pubkey)) : null
  return (
    <div className="space-y-6">
      <Reconnecting stale={p.stale} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <div className="space-y-6" data-column="left">
          <Scorebug game={game} run={run} />
          <Dial
            price={dial.price}
            modelProb={game.modelProb}
            timeLeft={dial.timeLeft}
            state={dial.state}
            team={game.home}
            label={dial.label}
            detail={stateLine(dial.state, game, dial.secsLeft, p.now)}
            liveDot={game.status === 'live'}
            stale={p.stale}
            runKey={runKeyOf(p.history, run)}
            className="mx-auto max-w-md"
          />
          {winner && (
            <Tape history={p.history} market={winner.pubkey} home={game.home} away={game.away} />
          )}
        </div>
        <div className="space-y-6" data-column="right">
          {p.right}
          <ResolutionCard game={game} />
        </div>
      </div>
      <details className="rounded-card border border-line p-4 text-13">
        <summary className="min-h-11 cursor-pointer content-center font-semibold text-ivory-100">
          Market rules
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-ash-400">
          {game.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}

/** First load: the dial frame at full size with the needle at 12 o'clock (spec 4.4). */
export function GameLoading({ stale }: { stale: boolean }) {
  return (
    <div className="space-y-3">
      <Reconnecting stale={stale} />
      <Dial
        loading
        stale={stale}
        price={null}
        modelProb={null}
        timeLeft={1}
        state="pre"
        team=""
        label="Loading game"
        className="mx-auto max-w-md"
      />
    </div>
  )
}

/** NOT_FOUND or INVALID_INPUT: a still face that says so, and the way back (spec 4.4). */
export function NoGame() {
  return (
    <div className="space-y-4 text-center">
      <Dial
        price={null}
        modelProb={null}
        timeLeft={0}
        state="void"
        team=""
        detail="No game here"
        label="No game here"
        className="mx-auto max-w-md"
      />
      <Link
        href="/"
        className="inline-flex min-h-11 items-center text-15 text-lume-300 underline-offset-4 hover:underline"
      >
        Back to tonight's games
      </Link>
    </div>
  )
}
