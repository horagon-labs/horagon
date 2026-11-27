// `horagon-ops deploy-check`, run by ops/deploy-keeper.sh on the VPS before it ships anything: is
// any game inside the window where a keeper restart costs something? A restart holds back the
// buzzer halt until the new process reads ESPN, delays a draft by its 60 s of stable Final, and
// pages `feed-silent:` for every open market past S + 1h40m. The window runs from tip-off - 60
// min (the market's create) to the close of its market: while the market is open, or halted on a
// game that is live or final and not yet resolved (no result proposed). A market halted on a
// game that was not played waits days for its NO result: it does not block. Exit 2 when a game
// blocks, 0 when none does.
import type { GameWithMarkets } from '@horagon/db'
import { DEFAULT_TIMINGS, type Timings } from '../planner'

export interface DeployBlocker {
  gameId: string
  /** `AWAY@HOME`. */
  name: string
  tipoff: Date
  gameStatus: string
  /** The winner market's status, or null when it has no market yet. */
  marketStatus: string | null
}

/** How far back the check reads tip-offs: a market still halted 48 h after S is `stuck:`. */
export const DEPLOY_CHECK_BACK_SECS = 48 * 3600

/** The games of `games` inside the window at `now` (Unix seconds), by tip-off. */
export function deployBlockers(
  games: readonly GameWithMarkets[],
  now: number,
  t: Pick<Timings, 'createLeadSecs' | 'createGraceSecs'> = DEFAULT_TIMINGS,
): DeployBlocker[] {
  const out: DeployBlocker[] = []
  for (const g of games) {
    // The main keeper runs NBA games only (R8): a Practice run never blocks its deploy.
    if (g.league !== 'NBA') continue
    const tip = Math.floor(g.scheduledTipoff.getTime() / 1000)
    if (now < tip - t.createLeadSecs) continue
    const m = g.markets.find((x) => x.kind === 0) ?? null
    const blocks = m
      ? m.status === 'open' ||
        (m.status === 'halted' && (g.status === 'live' || g.status === 'final'))
      : // No market yet: the keeper may still create it, until S + 30 min of a game not started.
        g.status === 'scheduled' && now < tip + t.createGraceSecs
    if (!blocks) continue
    out.push({
      gameId: g.id,
      name: `${g.away}@${g.home}`,
      tipoff: g.scheduledTipoff,
      gameStatus: g.status,
      marketStatus: m?.status ?? null,
    })
  }
  return out.sort((a, b) => a.tipoff.getTime() - b.tipoff.getTime())
}

/** What `deploy-check` prints. */
export function deployCheckLines(blockers: readonly DeployBlocker[], now: number): string[] {
  const at = new Date(now * 1000).toISOString()
  if (blockers.length === 0) {
    return [`clear at ${at}: no game is between tip-off - 60 min and the close of its market`]
  }
  return [
    `blocked at ${at}: ${blockers.length} game${blockers.length === 1 ? ' is' : 's are'} between tip-off - 60 min and the close of their market`,
    ...blockers.map(
      (b) =>
        `  ${b.gameId}  ${b.name}  tip-off ${b.tipoff.toISOString()}  game:${b.gameStatus}  ${b.marketStatus ? `market:${b.marketStatus}` : 'no market yet'}`,
    ),
  ]
}
