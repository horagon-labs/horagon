'use client'
// The live board (spec 4.1, 4.4): the Night dial on top (left from 1024 px), the rows below
// (right), the follow chips, and the shared loading, empty, stale and error states. Hovering a
// row lights its arc and hovering an arc lights its row.
import type { Game, PositionsResponse } from '@horagon/sdk'
import { boardModel } from '../../lib/chrono/board'
import type { Health } from '../../lib/chrono/health'
import { ErrorText } from '../error-text'
import { DialRow } from './dial-row'
import { NightDial } from './night-dial'

export interface BoardViewProps {
  games: Game[] | undefined
  portfolio: PositionsResponse | undefined
  now: number
  health: Health
  follows: string[]
  onToggleFollow: (team: string) => void
  selectedId: string | null
  onSelect: (id: string) => void
  hoverId: string | null
  onHover: (id: string | null) => void
}

export function BoardView(p: BoardViewProps) {
  const model = boardModel(p.games, p.portfolio, p.now, p.follows)
  // Three failures before any data: the error text replaces the loading line.
  const empty = p.games === undefined && p.health.error ? '' : (model.empty ?? '')
  return (
    <div className="space-y-4 lg:grid lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-start lg:gap-8 lg:space-y-0">
      <div className="mx-auto w-full max-w-sm lg:sticky lg:top-20 lg:max-w-none">
        <NightDial
          items={model.items}
          now={model.chainNow}
          selectedId={p.selectedId}
          onSelect={p.onSelect}
          hoverId={p.hoverId}
          onHover={p.onHover}
          emptyText={empty}
          stale={p.health.stale}
        />
        {p.health.stale && (
          <p role="status" className="mt-2 text-center font-mono text-11 text-red-400">
            Reconnecting…
          </p>
        )}
      </div>
      <div className="space-y-3">
        <h1 className="text-11 uppercase tracking-[0.3em] text-brass-500">Tonight</h1>
        {model.teams.length > 0 && (
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Follow teams</legend>
            {model.teams.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={p.follows.includes(t)}
                onClick={() => p.onToggleFollow(t)}
                className="min-h-11 rounded-full border border-line px-3 text-13 text-ash-400 aria-pressed:border-lume-300 aria-pressed:text-lume-300"
              >
                {p.follows.includes(t) ? '★' : '☆'} {t}
              </button>
            ))}
          </fieldset>
        )}
        <ErrorText error={p.health.error} />
        {/* The dial's own words are hidden from screen readers; the empty line is said here. */}
        {empty && (
          <p role="status" className="sr-only">
            {empty}
          </p>
        )}
        <ul className="space-y-2">
          {model.items.map((i) => (
            <li key={i.id}>
              <DialRow item={i} lit={p.hoverId === i.id} onHover={p.onHover} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
