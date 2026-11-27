// /verify/[market]'s lookup (R6 part B): the market's game, and the resolution that names the
// market, from API v1 alone. Used by the server shell (for the title) and by the view, so it holds
// no web3.js; the checks are in lib/verify.ts.
import type { Resolution } from '@horagon/sdk'
import { etClock } from './chrono/time'

/** The page's lookup: the market's game, and the resolution that names the market. */
export interface VerifyTarget {
  gameId: string
  away: string
  home: string
  resolution: Resolution
}

/** What the lookup reads: `GET /markets/{market}` then `GET /games/{gameId}`. */
export interface LookupClient {
  markets: { get: (pubkey: string) => Promise<{ gameId: string }> }
  games: {
    get: (id: string) => Promise<{ home: string; away: string; resolutions: Resolution[] }>
  }
}

/** The game and resolution of `market`, or null when no Horagon market has that address. */
export async function lookupTarget(
  client: LookupClient,
  market: string,
): Promise<VerifyTarget | null> {
  const { gameId } = await client.markets.get(market)
  const game = await client.games.get(gameId)
  const resolution = game.resolutions.find((r) => r.market === market)
  if (!resolution) return null
  return { gameId, away: game.away, home: game.home, resolution }
}

/** "2026-11-29 02:05 UTC · 9:05 PM ET". */
const both = (ts: number) =>
  `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${etClock(ts)}`

/** The line above the checks: the account's state, and the challenge window's end once proposed. */
export function verifyStatus(
  r: { status: string | null; windowEndsAt: number | null },
  now: number,
): string | null {
  switch (r.status) {
    case 'proposed':
      if (r.windowEndsAt === null) return 'Proposed on chain'
      return `Proposed on chain · the challenge window ${now >= r.windowEndsAt ? 'ended' : 'ends'} ${both(r.windowEndsAt)}`
    case 'finalized':
    case 'recycled':
      return 'Final on chain'
    case 'challenged':
      return 'Under review on chain'
    case 'open':
    case 'halted':
      return 'Not proposed yet'
    default:
      return null
  }
}
