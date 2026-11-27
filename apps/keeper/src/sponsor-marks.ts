// Pages the sponsor budget marks the API logs (`sponsor-cap-50`, `sponsor-cap-80` in ops_events,
// once per UTC day each: packages/api sponsor/submit.ts) as `sponsor-cap:<mark>:<UTC date>`. The API has no Telegram of its own, so
// the keeper's index loop reads them about once a minute. What was paged is kept in the
// `sponsor-marks` row of keeper_heartbeats, so a restart does not page a mark twice; a message
// Telegram did not take is tried again on the next run.
import { type Db, getHeartbeat, heartbeat, listOpsSince } from '@horagon/db'
import type { Logger } from 'pino'
import type { Alerter } from './alerts'

export const SPONSOR_MARK_ACTIONS = ['sponsor-cap-50', 'sponsor-cap-80'] as const
const RECORD = 'sponsor-marks'
/** Marks this old are no longer paged (a day, plus the slack of a keeper that was down). */
const LOOKBACK_SECS = 26 * 3600

const sol = (lamports: unknown) => {
  const n = Number(lamports)
  return Number.isFinite(n) ? `${n / 1e9}` : '?'
}

/** One run: pages the marks not paged yet, and returns how many went out. */
export async function pageSponsorMarks(d: {
  db: Db
  alerts: Alerter
  log: Logger
  now: () => number
}): Promise<number> {
  const since = new Date((d.now() - LOOKBACK_SECS) * 1000)
  const events = await listOpsSince(d.db, since, SPONSOR_MARK_ACTIONS)
  if (events.length === 0) return 0
  const record = await getHeartbeat(d.db, RECORD)
  const before = record?.info.paged
  const paged = new Set(Array.isArray(before) ? before.filter((v) => typeof v === 'number') : [])
  let sent = 0
  for (const e of events) {
    if (paged.has(e.id)) continue
    const mark = e.action.slice('sponsor-cap-'.length)
    const day = typeof e.detail.day === 'string' ? e.detail.day : e.ts.toISOString().slice(0, 10)
    const delivered = await d.alerts.send(
      `sponsor-cap:${mark}:${day}`,
      `Sponsor budget passed ${mark}% of the daily cap on ${day} (UTC): ${sol(e.detail.spentLamports)} of ${sol(e.detail.capLamports)} SOL reserved. New wallets stop at the cap less SPONSOR_RESERVE_SOL`,
    )
    if (delivered === false) continue
    paged.add(e.id)
    sent++
  }
  if (sent > 0) {
    // Only the ids still in the window: the row stays small.
    const kept = events.filter((e) => paged.has(e.id)).map((e) => e.id)
    await heartbeat(d.db, RECORD, { paged: kept })
    d.log.info({ sent }, 'sponsor budget marks paged')
  }
  return sent
}
