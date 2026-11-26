// Reads of the disclosed reference agent (apps/keeper/src/agent): the markets it may trade, the
// fan trades that make it step aside, its own spend per market, and the settled markets where it
// may hold winning shares. The keeper's tick writes the game rows; the indexer fills `trades`.
import { and, asc, count, eq, gte, inArray, max, ne, notExists, sql } from 'drizzle-orm'
import type { Db } from './client'
import { games, markets, redeemsClaims, trades } from './schema'

export interface AgentMarketRow {
  /** The pm-AMM market account. */
  pubkey: string
  marketId: string
  gameId: string
  kind: number
  status: string
  endTs: Date
  league: string
  home: string
  away: string
  gameStatus: string
  scheduledTipoff: Date
  /** Home win probability: the YES outcome of a winner market (kind 0). */
  modelProb: number | null
  /** The feed read that last wrote `modelProb` (`updateGameLive` writes both together). */
  feedUpdatedAt: Date | null
}

/**
 * Winner markets (kind 0) still open on a live game, in the given leagues. The agent checks
 * every rule again on what this returns; the filter only keeps the read small.
 */
export async function listAgentMarkets(db: Db, leagues: string[]): Promise<AgentMarketRow[]> {
  if (leagues.length === 0) return []
  return db
    .select({
      pubkey: markets.pubkey,
      marketId: markets.marketId,
      gameId: markets.gameId,
      kind: markets.kind,
      status: markets.status,
      endTs: markets.endTs,
      league: games.league,
      home: games.home,
      away: games.away,
      gameStatus: games.status,
      scheduledTipoff: games.scheduledTipoff,
      modelProb: games.modelProb,
      feedUpdatedAt: games.feedUpdatedAt,
    })
    .from(markets)
    .innerJoin(games, eq(games.id, markets.gameId))
    .where(
      and(
        eq(markets.kind, 0),
        eq(markets.status, 'open'),
        eq(games.status, 'live'),
        inArray(games.league, leagues),
      ),
    )
    .orderBy(asc(markets.endTs), asc(markets.pubkey))
}

/**
 * Per market, the block time of the newest trade at or after `since` by any wallet but `wallet`.
 * Markets without one are absent.
 */
export async function lastOtherTrades(
  db: Db,
  marketKeys: string[],
  wallet: string,
  since: Date,
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>()
  if (marketKeys.length === 0) return out
  const rows = await db
    .select({ market: trades.market, last: max(trades.blockTime) })
    .from(trades)
    .where(
      and(
        inArray(trades.market, marketKeys),
        ne(trades.wallet, wallet),
        gte(trades.blockTime, since),
      ),
    )
    .groupBy(trades.market)
  for (const r of rows) if (r.last) out.set(r.market, r.last)
  return out
}

const BUYS = ['usdcToYes', 'usdcToNo']

/** Per market, the raw mUSDC a wallet spent on buys and how many swaps it made. */
export async function walletMarketTotals(
  db: Db,
  wallet: string,
  marketKeys: string[],
): Promise<Map<string, { spent: bigint; swaps: number }>> {
  const out = new Map<string, { spent: bigint; swaps: number }>()
  if (marketKeys.length === 0) return out
  const rows = await db
    .select({
      market: trades.market,
      spent: sql<string>`coalesce(sum(case when ${inArray(trades.direction, BUYS)} then ${trades.usdcAmount} else 0 end), 0)`,
      swaps: count(),
    })
    .from(trades)
    .where(and(eq(trades.wallet, wallet), inArray(trades.market, marketKeys)))
    .groupBy(trades.market)
  for (const r of rows) out.set(r.market, { spent: BigInt(r.spent), swaps: Number(r.swaps) })
  return out
}

/**
 * Settled markets (finalized or recycled) where `wallet` traded and has no claim recorded yet:
 * where it may hold winning shares. The chain decides whether it does.
 */
export async function walletClaimableMarkets(db: Db, wallet: string) {
  return db
    .select({ pubkey: markets.pubkey, gameId: markets.gameId })
    .from(markets)
    .where(
      and(
        inArray(markets.status, ['finalized', 'recycled']),
        inArray(
          markets.pubkey,
          db
            .selectDistinct({ market: trades.market })
            .from(trades)
            .where(eq(trades.wallet, wallet)),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(redeemsClaims)
            .where(
              and(
                eq(redeemsClaims.market, markets.pubkey),
                eq(redeemsClaims.wallet, wallet),
                eq(redeemsClaims.kind, 'claim'),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(markets.endTs), asc(markets.pubkey))
}
