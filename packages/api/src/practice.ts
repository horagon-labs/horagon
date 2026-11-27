// GET /api/v1/practice (R8): the Practice run in flight, the next run's tip-off and who else
// trades the replay. Practice games are league PRACTICE, which nothing counts and `GET /games`
// never lists. Pure helpers, plus the DB read.
import { type Db, type GameWithMarkets, getHeartbeat, latestPrices, listGames } from '@horagon/db'
import type { PracticeResponse } from '@horagon/sdk'
import { toGame } from './views'

/** A run is the current one from 15 min before its tip-off (its market opens 10 min before)... */
const CURRENT_BEFORE_SECS = 15 * 60
/** ...to 90 min after: through the Final, the window and the finalize, and a while to read it. */
const CURRENT_AFTER_SECS = 90 * 60
/** A heartbeat older than this says the process is not running. */
const FRESH_SECS = 120

interface Beat {
  ts: Date
  info: Record<string, unknown>
}

const fresh = (hb: Beat | null, now: number): hb is Beat =>
  hb !== null && now - Math.floor(hb.ts.getTime() / 1000) <= FRESH_SECS

/** The latest run whose tip-off is within [now - 90 min, now + 15 min], else null. */
export function currentPractice<G extends Pick<GameWithMarkets, 'scheduledTipoff'>>(
  games: readonly G[],
  now: number,
): G | null {
  let best: G | null = null
  for (const g of games) {
    const tip = Math.floor(g.scheduledTipoff.getTime() / 1000)
    if (tip < now - CURRENT_AFTER_SECS || tip > now + CURRENT_BEFORE_SECS) continue
    if (!best || g.scheduledTipoff > best.scheduledTipoff) best = g
  }
  return best
}

/**
 * `agent` only when the reference agent's heartbeat is fresh and says it trades for real
 * (`dryRun: false`), PRACTICE markets included (`practice: true`), not paused or stopped.
 */
export function counterpartyOf(hb: Beat | null, now: number): PracticeResponse['counterparty'] {
  if (!fresh(hb, now)) return 'none'
  const i = hb.info
  const live = i.dryRun === false && i.practice === true && i.paused !== true && i.stopped !== true
  return live ? 'agent' : 'none'
}

/** The next run's tip-off, from a fresh Practice heartbeat only, and only if still ahead. */
export function nextPracticeAt(hb: Beat | null, now: number): number | null {
  if (!fresh(hb, now)) return null
  const at = hb.info.nextAt
  return typeof at === 'number' && Number.isInteger(at) && at > now ? at : null
}

export async function practiceFor(db: Db, now: number): Promise<PracticeResponse> {
  const [games, agent, practice] = await Promise.all([
    listGames(db, {
      from: new Date((now - CURRENT_AFTER_SECS) * 1000),
      to: new Date((now + CURRENT_BEFORE_SECS + 1) * 1000),
      leagues: ['PRACTICE'],
    }),
    getHeartbeat(db, 'agent'),
    getHeartbeat(db, 'practice'),
  ])
  const current = currentPractice(games, now)
  const prices = current
    ? await latestPrices(
        db,
        current.markets.map((m) => m.pubkey),
      )
    : new Map()
  return {
    current: current ? toGame(current, prices) : null,
    nextAt: nextPracticeAt(practice, now),
    counterparty: counterpartyOf(agent, now),
  }
}
