'use client'
// One game in the board's list (spec 3.2, L1 style): MiniDial, teams and score, whose chance the
// number is and the number in percent (R5), the close in ET and a diamond for your position.
// The whole row is one link to the game.
import Link from 'next/link'
import { type BoardItem, itemLabel, rowWords } from '../../lib/chrono/board'
import { liveNumber } from '../../lib/chrono/copy'
import { etClock } from '../../lib/chrono/time'
import { gameClock } from '../../lib/format'
import { MiniDial } from './mini-dial'

export function DialRow(p: {
  item: BoardItem
  /** Hovered here or on the Night dial (spec 4.1). */
  lit?: boolean
  onHover?: (id: string | null) => void
}) {
  const { item } = p
  const g = item.game
  const words = rowWords(item)
  // Lume while the number is a live chance; ash once trading stopped (audit section 3).
  const tone = liveNumber(item.state) ? 'text-lume-300' : 'text-ash-400'
  return (
    <Link
      href={`/game/${encodeURIComponent(g.id)}`}
      aria-label={itemLabel(item)}
      data-lit={p.lit ? 'true' : undefined}
      onPointerEnter={() => p.onHover?.(g.id)}
      onPointerLeave={() => p.onHover?.(null)}
      onFocus={() => p.onHover?.(g.id)}
      onBlur={() => p.onHover?.(null)}
      className="flex min-h-16 items-center gap-3 rounded-card border border-brass-500/15 px-3 py-2 hover:bg-enamel-800 data-[lit=true]:bg-enamel-800"
    >
      <MiniDial price={item.price} timeLeft={item.timeLeft} state={item.state} held={item.held} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-15 text-ivory-100">
          {g.away} @ {g.home}
        </span>
        <span className="block font-mono text-13 text-ash-400 tabular-nums">
          {g.status === 'scheduled'
            ? `tip-off ${etClock(item.interval.tip)}`
            : `${g.awayScore}–${g.homeScore} · ${gameClock(g)}`}
        </span>
      </span>
      <span className="shrink-0 text-right">
        {words.subject && (
          <span className="block text-12 text-brass-400" data-subject>
            {words.subject}
          </span>
        )}
        {words.value && (
          <span className={`block font-mono text-19 tabular-nums ${tone}`}>{words.value}</span>
        )}
        {words.note && <span className="block font-mono text-12 text-ash-400">{words.note}</span>}
      </span>
      {item.held && <span className="text-15 text-lume-300">◆</span>}
    </Link>
  )
}
