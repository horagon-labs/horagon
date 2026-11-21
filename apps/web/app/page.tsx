'use client'
// Tonight: games of the next 24 h in the viewer's time, live first after featured.
import { useEffect, useState } from 'react'
import { ErrorText } from '../components/error-text'
import { GameCard } from '../components/game-card'
import { api } from '../lib/api'
import { loadFollows, toggleFollow } from '../lib/follows'
import { isTonight, tonightOrder } from '../lib/format'
import { usePoll } from '../lib/use-poll'

const storage = () => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export default function TonightPage() {
  const { data, error } = usePoll('games', () => api.games.list())
  const [follows, setFollows] = useState<string[]>([])
  useEffect(() => setFollows(loadFollows(storage())), [])

  const now = Date.now()
  const games = (data ?? []).filter((g) => isTonight(g, now)).sort(tonightOrder)
  const teams = [...new Set(games.flatMap((g) => [g.away, g.home]))].sort()
  const shown =
    follows.length === 0
      ? games
      : games.filter((g) => follows.includes(g.home) || follows.includes(g.away))

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Tonight</h1>
      {teams.length > 0 && (
        <fieldset className="flex flex-wrap gap-2">
          <legend className="sr-only">Follow teams</legend>
          {teams.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={follows.includes(t)}
              onClick={() => setFollows(toggleFollow(storage(), t))}
              className="rounded-full border border-zinc-300 px-3 py-1 text-sm aria-pressed:border-zinc-900 aria-pressed:bg-zinc-900 aria-pressed:text-white dark:border-zinc-700"
            >
              {follows.includes(t) ? '★' : '☆'} {t}
            </button>
          ))}
        </fieldset>
      )}
      <ErrorText error={data === undefined ? error : undefined} />
      {data === undefined && !error && <p className="text-zinc-500">Loading games…</p>}
      {data !== undefined && shown.length === 0 && (
        <p className="text-zinc-500">
          {follows.length > 0
            ? 'No games for the teams you follow in the next 24 hours.'
            : 'No NBA games in the next 24 hours.'}
        </p>
      )}
      <div className="space-y-3">
        {shown.map((g) => (
          <GameCard key={g.id} game={g} />
        ))}
      </div>
    </div>
  )
}
