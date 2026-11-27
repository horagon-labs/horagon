// /verify/[market]'s lookup (R6 part B): the market's game, and the resolution that names the
// market, from API v1 alone. Used by the server shell (for the title) and by the view, so it holds
// no web3.js; the checks are in lib/verify.ts.
import type { Resolution } from '@horagon/sdk'

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
