// `horagon-ops watchdog`, run by a systemd timer every 2 min: pages when the keeper heartbeat is
// stale during a game window (spec 12). Each run is a new process, so the alerter's dedupe
// cannot hold a page back: the last page time is kept in the `watchdog` heartbeat row, and a
// stale heartbeat pages again only every 15 min. A DB that cannot be read pages on every run,
// since there is nowhere to keep that page time.
import { type Db, getHeartbeat, heartbeat, listGames } from '@horagon/db'
import { errorSummary } from '@horagon/sdk'
import type { Logger } from 'pino'
import type { Alerter } from '../alerts'
import { heartbeatStale } from './args'

/** While the heartbeat stays stale, seconds between two pages. */
export const WATCHDOG_REPAGE_SECS = 900

/** Whether to page now, and the page time to keep: null once the heartbeat is fresh again. */
export function watchdogPage(
  stale: boolean,
  lastPagedAt: number | null,
  nowSecs: number,
  everySecs = WATCHDOG_REPAGE_SECS,
): { page: boolean; pagedAt: number | null } {
  if (!stale) return { page: false, pagedAt: null }
  if (lastPagedAt !== null && nowSecs - lastPagedAt < everySecs) {
    return { page: false, pagedAt: lastPagedAt }
  }
  return { page: true, pagedAt: nowSecs }
}

/**
 * One watchdog run: exit code 2 when the heartbeat is stale during a game window, else 0. A DB
 * read failure pages (`watchdog`) and is rethrown: an unreadable heartbeat is not a fresh one.
 */
export async function watchdogRun(
  db: Db,
  alerts: Alerter,
  nowSecs: number,
  log: Logger,
): Promise<number> {
  let age: number | null
  let tipoffs: number[]
  let lastPagedAt: number | null
  try {
    const hb = await getHeartbeat(db, 'keeper')
    age = hb ? nowSecs - Math.floor(hb.ts.getTime() / 1000) : null
    const games = await listGames(db, {
      from: new Date((nowSecs - 5 * 3600) * 1000),
      to: new Date((nowSecs + 2 * 3600) * 1000),
      // A game night is an NBA night: the Practice process has its own `practice-failing`.
      leagues: ['NBA'],
    })
    tipoffs = games.map((g) => Math.floor(g.scheduledTipoff.getTime() / 1000))
    const paged = (await getHeartbeat(db, 'watchdog'))?.info.pagedAt
    lastPagedAt = typeof paged === 'number' ? paged : null
  } catch (err) {
    await alerts.send(
      'watchdog',
      `Watchdog cannot read the keeper heartbeat: ${errorSummary(err).message}`,
    )
    throw err
  }
  const stale = heartbeatStale(age, tipoffs, nowSecs)
  const next = watchdogPage(stale, lastPagedAt, nowSecs)
  if (next.page) {
    await alerts.send(
      'heartbeat',
      `Keeper heartbeat is ${age ?? 'missing'} s old during a game night`,
    )
  }
  if (next.pagedAt !== lastPagedAt) {
    try {
      await heartbeat(db, 'watchdog', { pagedAt: next.pagedAt })
    } catch (err) {
      // The page went out; the next run pages again rather than staying quiet.
      log.warn({ error: errorSummary(err).message }, 'watchdog could not keep its page time')
    }
  }
  return stale ? 2 : 0
}
