'use client'
// The live board (spec 4.1, 4.4): the rows first and the Night dial under them on a phone, so the
// first game is above the fold (R5); from 1024 px the dial sits left of the rows. The rows come
// first in the DOM too, so focus and screen readers meet them in the order the phone shows them
// (WCAG 2.4.3); only the desktop grid moves the dial column first. The follow chips fold behind
// "Follow teams". Shared loading, empty, stale and error states. Hovering a row lights its arc
// and hovering an arc lights its row. Under the heading (first-screen spec C17, C18): the count
// line, "● 4 markets open now · Pick a game" (the dot Live blue, as only an open market is) or
// "First market opens in 14 h 44 min", then how a market opens; the calendar button sits under
// the list (C23). While no market is open, an idle face (the story card, W5) takes the dial's
// slot: first below lg, the list after it and the idle foot after the list; from lg the face and
// its foot share the left column and the list runs down the right one.
import type { Game, PositionsResponse } from '@horagon/sdk'
import type { ReactNode } from 'react'
import {
  type BoardItem,
  boardModel,
  followChips,
  followSummary,
  openNow,
  type Upcoming,
} from '../../lib/chrono/board'
import { SELECTED } from '../../lib/chrono/controls'
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
  /** The idle face (first-screen W5): shown in the dial's slot while no market is open. */
  idleFace?: ReactNode
  /** What follows the idle face: under the list below lg, under the face from lg. */
  idleFoot?: ReactNode
}

/** C18, word for word. */
export const BOARD_NOTE =
  "Each market opens 60 min before tip-off at the model's chance at that time."

export function BoardView(p: BoardViewProps) {
  const filter = p.showAll ? [] : p.follows
  const model = boardModel(p.games, p.portfolio, p.now, filter, p.upcoming ?? null)
  // Three failures before any data: the error text replaces the loading line.
  const empty = p.games === undefined && p.health.error ? '' : (model.empty ?? '')
  const chips = p.games === undefined ? [] : followChips(model.teams, p.follows)
  // The idle face takes the dial's slot until a market opens; the poll swaps it, no reload.
  const idle = p.idleFace != null && model.openNow === 0
  // On the idle face's rest card (S1): "The dial rests until Sat, Dec 5." then the count, muted.
  const cut = model.rest?.indexOf('. ') ?? -1
  const restLines =
    model.rest === null
      ? []
      : cut < 0
        ? [model.rest]
        : [model.rest.slice(0, cut + 1), model.rest.slice(cut + 2)]
  // The first trading row in the order shown: the target of "Pick a game".
  const firstOpen = [...model.list, ...model.later.flatMap((n) => n.items)].find(openNow)?.id
  const row = (i: BoardItem) => (
    <li key={i.id}>
      <DialRow
        item={i}
        now={p.now}
        first={i.id === firstOpen}
        lit={p.hoverId === i.id}
        onHover={p.onHover}
      />
    </li>
  )
  return (
    <div
      className={
        idle
          ? 'flex flex-col gap-6 lg:grid lg:grid-cols-[34rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:items-start lg:gap-x-8 lg:gap-y-6'
          : 'flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-start lg:gap-8'
      }
    >
      {idle && (
        <div className="min-w-0 lg:col-start-1 lg:row-start-1" data-idle-face>
          {p.idleFace}
        </div>
      )}
      <div
        className={
          idle ? 'min-w-0 space-y-3 lg:col-start-2 lg:row-span-2 lg:row-start-1' : 'space-y-3'
        }
        data-board-list
      >
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          <h2 className="text-13 font-medium uppercase tracking-[0.2em] text-brass-500">
            {model.label}
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
                    className={`min-h-11 rounded-full border border-line px-3 text-13 text-ash-400 aria-pressed:text-ivory-100 ${SELECTED}`}
                  >
                    {p.follows.includes(t) ? '★' : '☆'} {t}
                  </button>
                ))}
              </fieldset>
            </details>
          )}
        </div>
        {model.openNow > 0 ? (
          <p className="text-13 text-ink" data-count>
            <span aria-hidden="true" className="text-live">
              ●
            </span>{' '}
            {model.openNow} {model.openNow === 1 ? 'market' : 'markets'} open now ·{' '}
            {/* min-h-11: a 44 px tap target inside the 13 px line. */}
            <a
              href="#first-open"
              className="inline-flex min-h-11 items-center underline underline-offset-4"
            >
              Pick a game
            </a>
          </p>
        ) : (
          model.firstOpen && (
            <p className="text-13 text-ink tabular-nums" data-count>
              {model.firstOpen}
            </p>
          )
        )}
        {model.note && (
          <p className="text-12 text-ink-muted" data-board-note>
            {BOARD_NOTE}
          </p>
        )}
        <ErrorText error={p.health.error} />
        {/* Under the dial otherwise; the idle face has no dial to sit under. */}
        {idle && p.health.stale && (
          <p role="status" className="font-mono text-12 text-red-400">
            Reconnecting…
          </p>
        )}
        {model.stopped && (
          <p className="text-13 text-ink" data-stopped>
            {model.stopped}
          </p>
        )}
        {idle && restLines.length > 0 && (
          <div className="space-y-1" data-rest-card>
            {restLines.map((line, i) => (
              <p key={line} className={i === 0 ? 'text-13 text-ink' : 'text-13 text-ink-muted'}>
                {line}
              </p>
            ))}
          </div>
        )}
        {model.next && !(idle && restLines.length > 0) && (
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
        <ul className="space-y-2">{model.list.map(row)}</ul>
        {model.later.map((night) => (
          <section key={night.label} className="space-y-2 pt-2" data-later>
            <h3 className="text-13 font-medium uppercase tracking-[0.2em] text-ink">
              {night.label}
            </h3>
            <ul className="space-y-2">{night.items.map(row)}</ul>
          </section>
        ))}
        {model.calendar && (
          // A file, not a page: a plain link, so the router never fetches it as one.
          <a
            href={model.calendar.href}
            className="inline-flex min-h-11 items-center rounded-card border border-rule px-4 text-13 text-ink hover:border-ink"
            data-calendar
          >
            {model.calendar.label}
          </a>
        )}
      </div>
      {idle ? (
        p.idleFoot != null && (
          <div className="min-w-0 lg:col-start-1 lg:row-start-2" data-idle-foot>
            {p.idleFoot}
          </div>
        )
      ) : (
        <div className="mx-auto w-full max-w-sm lg:sticky lg:top-20 lg:order-first lg:max-w-none">
          <NightDial
            items={model.dial}
            now={model.chainNow}
            selectedId={p.selectedId}
            onSelect={p.onSelect}
            hoverId={p.hoverId}
            onHover={p.onHover}
            emptyText={model.rest ?? model.stopped ?? empty}
            rest={model.rest !== null}
            stale={p.health.stale}
          />
          {p.health.stale && (
            <p role="status" className="mt-2 text-center font-mono text-12 text-red-400">
              Reconnecting…
            </p>
          )}
        </div>
      )}
    </div>
  )
}
