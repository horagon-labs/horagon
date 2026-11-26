'use client'
// The live board (spec 4.1, 4.4): the rows first and the Night dial under them on a phone, so the
// first game is above the fold (R5); from 1024 px the dial sits left of the rows. The rows come
// first in the DOM too, so focus and screen readers meet them in the order the phone shows them
// (WCAG 2.4.3); only the desktop grid moves the dial column first. The follow chips fold behind
// "Follow teams". Shared loading, empty, stale and error states. Hovering a row lights its arc
// and hovering an arc lights its row.
import type { Game, PositionsResponse } from '@horagon/sdk'
import { boardModel, followChips, followSummary, type Upcoming } from '../../lib/chrono/board'
import type { Health } from '../../lib/chrono/health'
import { ErrorText } from '../error-text'
import { DialRow } from './dial-row'
import { NightDial } from './night-dial'

export interface BoardViewProps {
  games: Game[] | undefined
  /** The next games past the list's days, from the server's first frame. */
  upcoming?: Upcoming | null
  portfolio: PositionsResponse | undefined
  now: number
  health: Health
  /** Every stored follow, tonight's teams or not. */
  follows: string[]
  onToggleFollow: (team: string) => void
  /** The follow filter is off for this view ("Show all games"); the follows stay stored. */
  showAll?: boolean
  onShowAll?: () => void
  selectedId: string | null
  onSelect: (id: string) => void
  hoverId: string | null
  onHover: (id: string | null) => void
}

export function BoardView(p: BoardViewProps) {
  const filter = p.showAll ? [] : p.follows
  const model = boardModel(p.games, p.portfolio, p.now, filter, p.upcoming ?? null)
  // Three failures before any data: the error text replaces the loading line.
  const empty = p.games === undefined && p.health.error ? '' : (model.empty ?? '')
  const chips = p.games === undefined ? [] : followChips(model.teams, p.follows)
  return (
    <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-start lg:gap-8">
      <div className="space-y-3" data-board-list>
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          <h2 className="text-13 font-medium uppercase tracking-[0.2em] text-brass-500">
            Tonight's games
          </h2>
          {chips.length > 0 && (
            <details className="group open:basis-full" data-follow>
              <summary className="ml-auto flex min-h-11 w-fit cursor-pointer list-none items-center gap-1 text-13 text-ash-400 hover:text-ivory-100 [&::-webkit-details-marker]:hidden">
                {followSummary(p.follows, p.showAll && p.follows.length > 0)}
                <span aria-hidden="true" className="group-open:rotate-180">
                  ▾
                </span>
              </summary>
              <fieldset className="mt-2 flex flex-wrap gap-2">
                <legend className="sr-only">Follow teams</legend>
                {chips.map((t) => (
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
            </details>
          )}
        </div>
        <ErrorText error={p.health.error} />
        {model.next && (
          <p className="text-13 text-ivory-100" data-next>
            {model.next}
          </p>
        )}
        {/* The dial's own words are hidden from screen readers; the empty line is said here. */}
        {empty && (
          <p role="status" className="sr-only">
            {empty}
          </p>
        )}
        {model.filtered && p.onShowAll && (
          <button
            type="button"
            onClick={p.onShowAll}
            className="min-h-11 rounded-card border border-line px-4 text-13 text-ivory-100 hover:border-lume-300"
            data-show-all
          >
            Show all games
          </button>
        )}
        <ul className="space-y-2">
          {model.items.map((i) => (
            <li key={i.id}>
              <DialRow item={i} lit={p.hoverId === i.id} onHover={p.onHover} />
            </li>
          ))}
        </ul>
      </div>
      <div className="mx-auto w-full max-w-sm lg:sticky lg:top-20 lg:order-first lg:max-w-none">
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
          <p role="status" className="mt-2 text-center font-mono text-12 text-red-400">
            Reconnecting…
          </p>
        )}
      </div>
    </div>
  )
}
