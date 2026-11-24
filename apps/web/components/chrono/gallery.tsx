'use client'
// The dev-only state gallery (app/dev/chrono): every DialState and the board's shared states,
// drawn from the fixtures at 9:08 PM ET, so each one can be screenshotted (spec 6.2).
import type { Game } from '@horagon/sdk'
import { type ReactNode, useState } from 'react'
import { evening, game, NOW, portfolio, position } from '../../lib/chrono/fixtures'
import type { Health } from '../../lib/chrono/health'
import { DIAL_STATES, type DialState, dialLabel } from '../../lib/chrono/state'
import { BoardView } from './board-view'
import { Dial } from './dial'
import { stateLine } from './dial-look'
import { MiniDial } from './mini-dial'

interface Sample {
  price: number | null
  timeLeft: number
  secsLeft: number | null
  game: Game
}

const live = game()
const later = game({ status: 'scheduled', scheduledTipoff: '2026-11-25T03:30:00Z' })

const SAMPLES: Record<DialState, Sample> = {
  resolved: { price: 1, timeLeft: 0, secsLeft: 0, game: game({ status: 'final' }) },
  challenged: { price: 0.97, timeLeft: 0, secsLeft: 0, game: game({ status: 'final' }) },
  proposed: { price: 1, timeLeft: 0, secsLeft: 0, game: game({ status: 'final' }) },
  void: { price: null, timeLeft: 0, secsLeft: null, game: game({ status: 'postponed' }) },
  halted: { price: 0.62, timeLeft: 0.4, secsLeft: 2_400, game: live },
  closed: { price: 0.88, timeLeft: 0, secsLeft: 0, game: game({ status: 'final' }) },
  closing: { price: 0.41, timeLeft: 0.02, secsLeft: 252, game: live },
  live: { price: 0.77, timeLeft: 0.33, secsLeft: 3_730, game: live },
  pre: { price: 0.55, timeLeft: 1, secsLeft: 9_000, game: later },
}

const OK: Health = { stale: false, error: undefined }
const STALE: Health = { stale: true, error: undefined }
const DOWN: Health = { stale: true, error: new Error('down') }

function Section(p: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-11 uppercase tracking-[0.3em] text-brass-500">{p.title}</h2>
      {p.children}
    </section>
  )
}

function Board(p: { games: Game[] | undefined; health: Health }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [follows, setFollows] = useState<string[]>([])
  return (
    <BoardView
      games={p.games}
      portfolio={portfolio([position()])}
      now={NOW}
      health={p.health}
      follows={follows}
      onToggleFollow={(t) =>
        setFollows((f) => (f.includes(t) ? f.filter((x) => x !== t) : [...f, t]))
      }
      selectedId={selectedId}
      onSelect={setSelectedId}
      hoverId={hoverId}
      onHover={setHoverId}
    />
  )
}

export function Gallery() {
  return (
    <div className="space-y-10 pb-10">
      <Section title="Dial states (spec 4.3)">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {DIAL_STATES.map((state) => {
            const s = SAMPLES[state]
            return (
              <figure key={state} className="space-y-1">
                <Dial
                  price={s.price}
                  modelProb={0.74}
                  timeLeft={s.timeLeft}
                  state={state}
                  team="CLE"
                  liveDot={s.game.status === 'live'}
                  detail={stateLine(state, s.game, s.secsLeft, NOW)}
                  label={dialLabel({
                    team: 'CLE',
                    price: s.price,
                    modelProb: 0.74,
                    state,
                    secsLeft: s.secsLeft,
                    gameStatus: s.game.status,
                  })}
                />
                <figcaption className="text-center font-mono text-11 text-ash-400">
                  {state}
                </figcaption>
              </figure>
            )
          })}
        </div>
      </Section>
      <Section title="Loading, stale, ghost (spec 4.4, 5.5)">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Dial
            loading
            price={null}
            modelProb={null}
            timeLeft={1}
            state="pre"
            team="CLE"
            label="Loading"
          />
          <Dial
            stale
            price={0.77}
            modelProb={0.74}
            timeLeft={0.33}
            state="live"
            team="CLE"
            label="Stale"
          />
          <Dial
            ghostPrice={0.81}
            price={0.77}
            modelProb={0.74}
            timeLeft={0.33}
            state="live"
            team="CLE"
            label="Ghost"
          />
        </div>
      </Section>
      <Section title="MiniDial">
        <div className="flex flex-wrap gap-3">
          {DIAL_STATES.map((state) => (
            <MiniDial
              key={state}
              price={SAMPLES[state].price}
              timeLeft={SAMPLES[state].timeLeft}
              state={state}
              held={state === 'live'}
            />
          ))}
        </div>
      </Section>
      <Section title="Board">
        <Board games={evening()} health={OK} />
      </Section>
      <Section title="Board loading">
        <Board games={undefined} health={OK} />
      </Section>
      <Section title="Board empty">
        <Board games={[]} health={OK} />
      </Section>
      <Section title="Board stale">
        <Board games={evening()} health={STALE} />
      </Section>
      <Section title="Board error after three failures">
        <Board games={undefined} health={DOWN} />
      </Section>
    </div>
  )
}
