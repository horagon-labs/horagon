'use client'
// One game in the board's list (spec 3.2, L1 style): MiniDial, teams and score with the team
// ahead first (or the ET tip-off), whose chance the number is and the number in percent (R5), a
// note and a diamond for your position. Before a market opens the number is the model's, ink-muted
// with " model" and a ▲ at the end of a dashed model arc on the MiniDial; while the market trades
// it is Live blue with its move since open (first-screen spec C19, C20). The whole row is one link
// to the game.
import Link from 'next/link'
import { type BoardItem, itemLabel, openNow, rowWords, scoreLine } from '../../lib/chrono/board'
import { etClock } from '../../lib/chrono/time'
import { MiniDial } from './mini-dial'

/** Live blue means one thing on a row: this market trades now (first-screen spec W4). */
const LIVE_NUMBER = 'text-live'

export function DialRow(p: {
  item: BoardItem
  /** The board's clock, for "opens in 14 h". */
  now: number
  /** The first trading row: the target of the count line's "Pick a game" (`#first-open`). */
  first?: boolean
  /** Hovered here or on the Night dial (spec 4.1). */
  lit?: boolean
  onHover?: (id: string | null) => void
}) {
  const { item } = p
  const g = item.game
  const words = rowWords(item, p.now)
  const score = g.status === 'scheduled' ? null : scoreLine(g)
  const tone = openNow(item) ? LIVE_NUMBER : item.state === 'halted' ? 'text-ink' : 'text-ink-muted'
  return (
    <Link
      href={`/game/${encodeURIComponent(g.id)}`}
      id={p.first ? 'first-open' : undefined}
      aria-label={itemLabel(item)}
      data-lit={p.lit ? 'true' : undefined}
      onPointerEnter={() => p.onHover?.(g.id)}
      onPointerLeave={() => p.onHover?.(null)}
      onFocus={() => p.onHover?.(g.id)}
      onBlur={() => p.onHover?.(null)}
      className="flex min-h-16 scroll-mt-20 items-center gap-3 rounded-card border border-line px-3 py-2 hover:border-ivory-100 data-[lit=true]:border-ivory-100"
    >
      <MiniDial
        price={item.price}
        model={item.market ? null : g.modelProb}
        timeLeft={item.timeLeft}
        state={item.state}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-15 text-ivory-100">
          {g.away} @ {g.home}
        </span>
        {score === null ? (
          <span className="block truncate font-mono text-13 text-ash-400 tabular-nums">
            {etClock(item.interval.tip)}
          </span>
        ) : (
          // The team ahead names the score (fresh-eyes note 6). A narrow row wraps between the
          // score and the clock, never inside one, so neither is cut.
          <span className="block font-mono text-13 text-ash-400 tabular-nums">
            <span className="whitespace-nowrap">{score[0]}</span>
            {' · '}
            <span className="whitespace-nowrap">{score[1]}</span>
          </span>
        )}
      </span>
      <span className="shrink-0 text-right">
        {words.subject && (
          <span className="block text-12 text-brass-400" data-subject>
            {words.subject}
          </span>
        )}
        {words.value && (
          <span className={`block font-mono text-19 tabular-nums ${tone}`}>
            {words.value}
            {words.model && <span className="font-sans text-12 text-ink-muted"> model</span>}
          </span>
        )}
        {words.note && (
          <span className="block font-mono text-12 text-ash-400">
            {words.note}
            {words.wide && <span className="hidden sm:inline">{words.wide}</span>}
          </span>
        )}
      </span>
      {/* Yours: a live ◆, told from the live needle by its shape (review §3.2 row 15). */}
      {item.held && <span className="text-15 text-live">◆</span>}
    </Link>
  )
}
