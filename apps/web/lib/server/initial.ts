// The first frame's data, loaded on the server (R5): the board's games and a game page's detail
// go into the first HTML, so neither page opens on "Setting the dial…" and a link unfurler or a
// crawler sees real content. Everything here is best effort: a slow or failing API leaves the
// value out, and the page's own poll loads it in the browser as before.
import type { Game, GameDetail, HoragonClient, RecordResponse } from '@horagon/sdk'
import { etNextDay, etNight, isHoragonError } from '@horagon/sdk'
import { nightOver, type Upcoming, upcomingOf } from '../chrono/board'
import { isTonight } from '../format'

/** How long a first frame waits for the API before it renders without the data. */
export const INITIAL_TIMEOUT_MS = 1_500
/** A first frame's data is shared for this long (the API caches its answers for 1 s, 5 s stale). */
export const INITIAL_TTL_MS = 3_000
/** On a day with no game ahead, how many more ET days the board looks for the next ones. */
export const LOOKAHEAD_DAYS = 6

export type BoardClient = Pick<HoragonClient, 'games'>

/** `p`'s value, or undefined once `ms` passed or when it fails. Never throws. */
export async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([p.catch(() => undefined), late])
  } finally {
    clearTimeout(timer)
  }
}

export interface InitialBoard {
  /** Tonight's games as the API lists them; undefined when the API did not answer in time. */
  games: Game[] | undefined
  /** The next games, when the default list (the ET night and the day after it) has nothing ahead. */
  upcoming: Upcoming | null
  /** Unix seconds the data is for: the first frame's clock, so the browser hydrates the same. */
  now: number
}

/**
 * The board's first frame. With no game on the board, or every game of the night stopped, and
 * none later in the list, it looks for the next games over the next LOOKAHEAD_DAYS ET days
 * (`lookAhead`).
 */
export async function loadBoard(
  client: BoardClient,
  nowSecs: number,
  timeoutMs = INITIAL_TIMEOUT_MS,
): Promise<InitialBoard> {
  const games = await within(client.games.list(), timeoutMs)
  if (!games) return { games: undefined, upcoming: null, now: nowSecs }
  const tonight = games.some((g) => isTonight(g, nowSecs * 1000))
  let upcoming = upcomingOf(games, nowSecs)
  // Also once every game of the night stopped, so "All stopped" can name the next tip-off.
  const ended = !tonight || nightOver(games, nowSecs)
  if (ended && upcoming === null) upcoming = await lookAhead(client, nowSecs, timeoutMs)
  return { games, upcoming, now: nowSecs }
}

/**
 * The next games past the default list's two days (`etNight` and the day after it): the next
 * LOOKAHEAD_DAYS ET days, stepped with `etNextDay`, are asked
 * all at once, under one `timeoutMs` cap for the lot (R5 review finding 8), and the first day
 * that has games answers. A day that fails or is still out when the cap ends stops the search
 * there, so a later day never passes for the next one. Never throws.
 */
export async function lookAhead(
  client: BoardClient,
  nowSecs: number,
  timeoutMs = INITIAL_TIMEOUT_MS,
): Promise<Upcoming | null> {
  let date = etNextDay(etNextDay(etNight(nowSecs)))
  const days = Array.from({ length: LOOKAHEAD_DAYS }, () => {
    const asked = date
    date = etNextDay(date)
    return client.games.list({ date: asked }).catch(() => undefined)
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), timeoutMs)
  })
  try {
    for (const day of days) {
      const more = await Promise.race([day, late])
      if (more === 'late' || more === undefined) return null
      const next = upcomingOf(more, nowSecs)
      if (next) return next
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}

export interface InitialGame {
  game: GameDetail | undefined
  /** The API says there is no such game (NOT_FOUND or a malformed id): the still face at once. */
  missing: boolean
  now: number
}

/** A game page's first frame. */
export async function loadGame(
  client: BoardClient,
  id: string,
  nowSecs: number,
  timeoutMs = INITIAL_TIMEOUT_MS,
): Promise<InitialGame> {
  let missing = false
  const game = await within(
    client.games.get(id).catch((err: unknown) => {
      missing = isHoragonError(err) && (err.code === 'NOT_FOUND' || err.code === 'INVALID_INPUT')
      throw err
    }),
    timeoutMs,
  )
  return { game, missing, now: nowSecs }
}

/**
 * Shares one answer per key for `ttlMs` (per server instance), so a burst of first frames costs
 * one API call. A failed or empty answer is not kept. At most `max` keys are held.
 */
export function ttlCache<T>(ttlMs: number, max = 200, nowMs: () => number = Date.now) {
  const held = new Map<string, { at: number; value: Promise<T> }>()
  return (key: string, load: () => Promise<T>, keep: (value: T) => boolean): Promise<T> => {
    const hit = held.get(key)
    if (hit && nowMs() - hit.at < ttlMs) return hit.value
    if (held.size >= max) {
      for (const [k, v] of held) if (nowMs() - v.at >= ttlMs) held.delete(k)
      if (held.size >= max) held.clear()
    }
    const value = load()
    held.set(key, { at: nowMs(), value })
    void value.then(
      (v) => {
        if (!keep(v)) held.delete(key)
      },
      () => held.delete(key),
    )
    return value
  }
}

/** How long / keeps the proof rail's counts: GET /record is cached 60 s at the edge too. */
export const RECORD_TTL_MS = 60_000

/**
 * The proof rail's counts (first-screen C6, C6m): GET /record under the first frame's cap. Null
 * when the API failed or was late; the rail then shows the program links alone. Never throws.
 */
export async function loadRecord(
  client: Pick<HoragonClient, 'record'>,
  timeoutMs = INITIAL_TIMEOUT_MS,
): Promise<RecordResponse | null> {
  return (await within(client.record(), timeoutMs)) ?? null
}
