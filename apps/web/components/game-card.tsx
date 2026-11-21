import type { Game } from '@horagon/sdk'
import Link from 'next/link'
import { cents, gameClock, percent } from '../lib/format'

export function GameCard({ game }: { game: Game }) {
  const winner = game.markets.find((m) => m.kind === 'winner')
  const started = game.status !== 'scheduled'
  return (
    <Link
      href={`/game/${game.id}`}
      className="block rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span className={game.status === 'live' ? 'font-semibold text-red-600' : ''}>
          {gameClock(game)}
        </span>
        {game.featured && (
          <span className="rounded bg-amber-200 px-1.5 font-semibold text-amber-900">Featured</span>
        )}
      </div>
      <div className="mt-1 grid grid-cols-[1fr_auto_auto] items-center gap-x-3 gap-y-1">
        <span className="font-semibold">{game.away}</span>
        <span className="text-right">{started ? game.awayScore : ''}</span>
        <span className="w-12 text-right text-away">
          {cents(winner?.price == null ? null : 1 - winner.price)}
        </span>
        <span className="font-semibold">{game.home}</span>
        <span className="text-right">{started ? game.homeScore : ''}</span>
        <span className="w-12 text-right text-home">{cents(winner?.price)}</span>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Model: {game.home} {percent(game.modelProb)}
        {winner ? ` · market ${winner.status}` : ' · market opens 60 min before tip-off'}
      </p>
    </Link>
  )
}
