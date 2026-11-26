import { and, asc, countDistinct, desc, eq, gte, inArray, isNull, ne, or } from 'drizzle-orm'
import type { Db } from './client'
import { markets, pricePoints, redeemsClaims, trades } from './schema'

export type NewMarket = typeof markets.$inferInsert
export type TradeRow = typeof trades.$inferSelect
export type ClaimRow = typeof redeemsClaims.$inferSelect
export type PricePointRow = typeof pricePoints.$inferSelect

export async function upsertMarket(db: Db, m: NewMarket): Promise<void> {
  const { pubkey: _pubkey, ...rest } = m
  await db
    .insert(markets)
    .values(m)
    .onConflictDoUpdate({ target: markets.pubkey, set: { ...rest, updatedAt: new Date() } })
}

export type MarketPatch = Partial<Omit<NewMarket, 'pubkey' | 'gameId' | 'marketId'>>

export async function updateMarket(db: Db, pubkey: string, patch: MarketPatch): Promise<void> {
  await db
    .update(markets)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(markets.pubkey, pubkey))
}

export async function getMarket(db: Db, pubkey: string) {
  const rows = await db.select().from(markets).where(eq(markets.pubkey, pubkey))
  return rows[0] ?? null
}

export async function listMarketsByGame(db: Db, gameId: string) {
  return db.select().from(markets).where(eq(markets.gameId, gameId)).orderBy(asc(markets.kind))
}

/** Spec section 8: every market not recycled, or recycled within the last day. */
export async function listIndexableMarkets(db: Db, now: Date) {
  const dayAgo = new Date(now.getTime() - 86_400_000)
  return db
    .select()
    .from(markets)
    .where(
      or(
        ne(markets.status, 'recycled'),
        isNull(markets.recycledAt),
        gte(markets.recycledAt, dayAgo),
      ),
    )
    .orderBy(asc(markets.endTs))
}

/** Every Horagon market's mints, for the sponsor's synchronous allowlist checks. */
export async function listMarketMints(
  db: Db,
): Promise<Array<{ pubkey: string; yesMint: string; noMint: string }>> {
  return db
    .select({ pubkey: markets.pubkey, yesMint: markets.yesMint, noMint: markets.noMint })
    .from(markets)
}

export async function insertTrades(db: Db, rows: Array<typeof trades.$inferInsert>): Promise<void> {
  if (rows.length > 0) await db.insert(trades).values(rows).onConflictDoNothing()
}

export async function insertClaims(
  db: Db,
  rows: Array<typeof redeemsClaims.$inferInsert>,
): Promise<void> {
  if (rows.length > 0) await db.insert(redeemsClaims).values(rows).onConflictDoNothing()
}

export async function insertPricePoint(db: Db, p: typeof pricePoints.$inferInsert): Promise<void> {
  await db.insert(pricePoints).values(p).onConflictDoNothing()
}

export async function listPricePoints(db: Db, marketKeys: string[]): Promise<PricePointRow[]> {
  if (marketKeys.length === 0) return []
  return db
    .select()
    .from(pricePoints)
    .where(inArray(pricePoints.market, marketKeys))
    .orderBy(asc(pricePoints.ts))
}

export async function latestPrices(
  db: Db,
  marketKeys: string[],
): Promise<Map<string, { price: number; ts: Date }>> {
  const out = new Map<string, { price: number; ts: Date }>()
  if (marketKeys.length === 0) return out
  const rows = await db
    .selectDistinctOn([pricePoints.market])
    .from(pricePoints)
    .where(inArray(pricePoints.market, marketKeys))
    .orderBy(pricePoints.market, desc(pricePoints.ts))
  for (const row of rows) out.set(row.market, { price: row.price, ts: row.ts })
  return out
}

export async function listMarketTrades(db: Db, marketKeys: string[]): Promise<TradeRow[]> {
  if (marketKeys.length === 0) return []
  return db
    .select()
    .from(trades)
    .where(inArray(trades.market, marketKeys))
    .orderBy(asc(trades.blockTime), asc(trades.sig), asc(trades.ixIndex))
}

/** Everything a wallet did on Horagon markets, oldest first: the input of the position view. */
export async function walletActivity(
  db: Db,
  wallet: string,
): Promise<{ trades: TradeRow[]; claims: ClaimRow[] }> {
  const [t, c] = await Promise.all([
    db
      .select()
      .from(trades)
      .where(eq(trades.wallet, wallet))
      .orderBy(asc(trades.blockTime), asc(trades.sig), asc(trades.ixIndex)),
    db
      .select()
      .from(redeemsClaims)
      .where(eq(redeemsClaims.wallet, wallet))
      .orderBy(asc(redeemsClaims.blockTime), asc(redeemsClaims.sig), asc(redeemsClaims.ixIndex)),
  ])
  return { trades: t, claims: c }
}

/** Signatures of trades indexed before `bot_memo` existed (null), oldest first, each once. */
export async function tradeSigsWithoutBotMemo(db: Db, limit: number): Promise<string[]> {
  const rows = await db
    .selectDistinct({ sig: trades.sig, blockTime: trades.blockTime })
    .from(trades)
    .where(isNull(trades.botMemo))
    .orderBy(asc(trades.blockTime), asc(trades.sig))
    .limit(limit)
  return rows.map((r) => r.sig)
}

/** Sets `bot_memo` on the rows of one transaction that are still null. Returns how many. */
export async function setTradeBotMemo(db: Db, sig: string, botMemo: boolean): Promise<number> {
  const rows = await db
    .update(trades)
    .set({ botMemo })
    .where(and(eq(trades.sig, sig), isNull(trades.botMemo)))
    .returning({ sig: trades.sig })
  return rows.length
}

/** Transactions with a trade whose `bot_memo` is still null. */
export async function countTradesWithoutBotMemo(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: countDistinct(trades.sig) })
    .from(trades)
    .where(isNull(trades.botMemo))
  return row?.n ?? 0
}

/**
 * The wallets of `wallets` that sent a swap with the `horagon:bot` memo on any market
 * (docs/metrics.md bot rule (a), per wallet). A null memo counts as false.
 */
export async function walletsWithBotMemo(db: Db, wallets: string[]): Promise<Set<string>> {
  if (wallets.length === 0) return new Set()
  const rows = await db
    .selectDistinct({ wallet: trades.wallet })
    .from(trades)
    .where(and(inArray(trades.wallet, wallets), eq(trades.botMemo, true)))
  return new Set(rows.map((r) => r.wallet))
}

export async function marketsByPubkeys(db: Db, pubkeys: string[]) {
  if (pubkeys.length === 0) return []
  return db.select().from(markets).where(inArray(markets.pubkey, pubkeys))
}

export async function marketsByStatus(db: Db, statuses: string[]) {
  return db
    .select()
    .from(markets)
    .where(and(inArray(markets.status, statuses)))
    .orderBy(asc(markets.endTs))
}
