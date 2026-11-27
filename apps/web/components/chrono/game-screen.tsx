'use client'
// The game screen (spec 4.2). One column on mobile: Scorebug, the big Dial, who traded (R2b),
// Tape, then the Pusher, PositionCard and ResolutionCard. From 1024 px the same two halves sit
// side by side: Scorebug, Dial, who traded and Tape on the left, the crown, PositionCard and
// ResolutionCard on the right.
import type { GameDetail, GameHistory } from '@horagon/sdk'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { winnerOf } from '../../lib/chrono/board'
import { faceCaption, liveNumber } from '../../lib/chrono/copy'
import { canTrade, type GameDial } from '../../lib/chrono/game'
import { findRuns, freshRun, latestRun } from '../../lib/chrono/runs'
import { AgentLine } from './agent-line'
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
    <p role="status" className="text-center font-mono text-12 text-red-400">
      Reconnecting…
    </p>
  ) : null
}

/**
 * The dial's state line, under the face rather than in it, so the caption keeps one line clear of
 * 0 and 100 (light branding review §4.2).
 */
export function StateLine({ children }: { children: string }) {
  return (
    <p className="mt-2 text-center text-13 text-ash-400" data-state-line>
      {children}
    </p>
  )
}

export function GameScreen(p: GameScreenProps) {
  const { game, dial } = p
  const winner = winnerOf(game)
  const latest = p.history && winner ? latestRun(findRuns(p.history, winner.pubkey)) : null
  // The Scorebug says "on an 8–0 run" in the present tense, so only while the game is live, the
  // number still moves and the run is recent. The flash key keeps the unfiltered run.
  const live = game.status === 'live' && liveNumber(dial.state)
  const run = live && p.history ? freshRun(latest, p.history) : null
  return (
    <div className="space-y-6">
      <Reconnecting stale={p.stale} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <div className="space-y-6" data-column="left">
          <Scorebug game={game} run={run} />
          <div>
            <Dial
              price={dial.price}
              modelProb={game.modelProb}
              timeLeft={dial.timeLeft}
              state={dial.state}
              caption={faceCaption(dial.state, game, winner?.outcome ?? null)}
              label={dial.label}
              liveDot={game.status === 'live'}
              stale={p.stale}
              runKey={runKeyOf(p.history, latest)}
              className="mx-auto max-w-md"
            />
            <StateLine>{stateLine(dial.state, game, dial.secsLeft, p.now)}</StateLine>
          </div>
          {winner && <AgentLine activity={game.activity} trading={canTrade(dial.state)} />}
          {winner && (
            <Tape history={p.history} market={winner.pubkey} home={game.home} away={game.away} />
          )}
        </div>
        <div className="space-y-6" data-column="right">
          {p.right}
          <ResolutionCard game={game} state={dial.state} now={p.now} />
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

/** First load: the dial frame at full size, with no needle and no number yet (R5). */
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
      <div>
        <Dial
          price={null}
          modelProb={null}
          timeLeft={0}
          state="void"
          label="No game here"
          className="mx-auto max-w-md"
        />
        <StateLine>No game here</StateLine>
      </div>
      <Link
        href="/"
        className="inline-flex min-h-11 items-center text-15 text-lume-300 underline-offset-4 hover:underline"
      >
        Back to tonight's games
      </Link>
    </div>
  )
}
