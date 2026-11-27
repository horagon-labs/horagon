'use client'
// The dev gallery's R8 part (app/dev/chrono): the stopped face with the buzzer index and each
// story plate, the Buzzer stop on a button, clutch dim, the ◆ and the move chip, the Practice
// plate with both counterparty lines. Each face has its reduced-motion twin beside it.
import { type ReactNode, useState } from 'react'
import { clutchLine } from '../../lib/chrono/clutch'
import { detail, game, history, market, NOW, position } from '../../lib/chrono/fixtures'
import { gameDial } from '../../lib/chrono/game'
import { stopLine } from '../../lib/chrono/stop'
import type { Story } from '../../lib/chrono/story'
import { Dial } from './dial'
import { GameScreen, StateLine } from './game-screen'
import { PracticeNote, PracticePlate } from './practice-plate'
import { StoryPlate } from './story-plate'

const STORIES: readonly Story[] = ['Upset', 'Comeback', 'Overtime']
const FINAL = game({ status: 'final', homeScore: 107, awayScore: 105, period: 4, clockSecs: null })

function Twins(p: { title: string; render: (reduced: boolean) => ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-13 font-semibold text-ink">{p.title}</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>{p.render(false)}</div>
        <div>
          {p.render(true)}
          <p className="text-center text-12 text-ink-muted">Reduced motion</p>
        </div>
      </div>
    </div>
  )
}

function StoppedFace(p: { story: Story; reduced: boolean; stop?: number }) {
  return (
    <div>
      <Dial
        price={0.88}
        modelProb={0.93}
        timeLeft={0}
        state="closed"
        label={stopLine(FINAL)}
        caption="Final · CLE won · result pending"
        stopPrice={0.71}
        entry={0.38}
        stop={p.stop ?? 0}
        reduced={p.reduced}
        className="mx-auto max-w-xs"
      />
      <div className="mt-2 flex justify-center">
        <StoryPlate story={p.story} />
      </div>
      <StateLine>{stopLine(FINAL)}</StateLine>
    </div>
  )
}

export function A2Gallery() {
  const [stop, setStop] = useState(0)
  const clutch = detail({ period: 4, clockSecs: 108, homeScore: 101, awayScore: 99 })
  const run = detail({ id: 'practice-401910007p0', league: 'PRACTICE' })
  return (
    <div className="space-y-8">
      {STORIES.map((story) => (
        <Twins
          key={story}
          title={`Stopped face · buzzer index · ${story}`}
          render={(reduced) => <StoppedFace story={story} reduced={reduced} />}
        />
      ))}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setStop((n) => n + 1)}
          className="min-h-11 rounded-full border border-rule px-4 text-13 text-ink"
        >
          Play the Buzzer stop
        </button>
        <Twins
          title="Buzzer stop"
          render={(reduced) => <StoppedFace story="Upset" reduced={reduced} stop={stop} />}
        />
      </div>
      <Twins
        title="Live · ◆ at the average entry · move chip"
        render={(reduced) => (
          <Dial
            price={0.67}
            modelProb={0.64}
            timeLeft={0.3}
            state="live"
            label="CLE to win, 67%"
            caption="CLE to win"
            liveDot
            entry={0.38}
            chip="+5"
            reduced={reduced}
            className="mx-auto max-w-xs"
          />
        )}
      />
      <div className="space-y-2">
        <h3 className="text-13 font-semibold text-ink">{clutchLine(clutch)}</h3>
        <GameScreen
          game={clutch}
          history={history()}
          dial={gameDial(clutch, market(), NOW - 3_730, null, NOW)}
          now={NOW}
          stale={false}
          right={null}
          positions={[position({ costUsdc: '5.36' })]}
        />
      </div>
      <div className="space-y-3">
        <h3 className="text-13 font-semibold text-ink">Practice</h3>
        <PracticePlate />
        <PracticeNote game={run} counterparty="none" />
        <PracticeNote game={run} counterparty="agent" />
      </div>
    </div>
  )
}
