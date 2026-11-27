import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  max,
  min,
  ne,
  or,
} from 'drizzle-orm'
import type { Db } from './client'
import { marketIdReservations, markets, pricePoints, redeemsClaims, trades } from './schema'

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

/** The market id stored for a game and kind (`market_id_reservations`), or null. */
export async function getMarketIdReservation(
  db: Db,
  gameId: string,
  kind: number,
): Promise<string | null> {
  const rows = await db
    .select({ marketId: marketIdReservations.marketId })
    .from(marketIdReservations)
    .where(and(eq(marketIdReservations.gameId, gameId), eq(marketIdReservations.kind, kind)))
  return rows[0]?.marketId ?? null
}

/**
 * Stores `marketId` for the game and kind unless one is stored already, and returns the stored
 * one: a second process (or a restart) that drew another id gets the first.
 */
export async function reserveMarketId(
  db: Db,
  r: { gameId: string; kind: number; marketId: string },
): Promise<string> {
  await db
    .insert(marketIdReservations)
    .values(r)
    .onConflictDoNothing({ target: [marketIdReservations.gameId, marketIdReservations.kind] })
  const stored = await getMarketIdReservation(db, r.gameId, r.kind)
  if (stored === null) throw new Error(`no market id stored for ${r.gameId} kind ${r.kind}`)
  return stored
}

/**
 * Replaces the stored id `from` with `to` (its PDA was taken by someone else) and returns the id
 * stored afterwards: `to`, or the id another process put there first.
 */
export async function replaceMarketIdReservation(
  db: Db,
  r: { gameId: string; kind: number; from: string; to: string },
): Promise<string> {
  await db
    .update(marketIdReservations)
    .set({ marketId: r.to, updatedAt: new Date() })
    .where(
      and(
        eq(marketIdReservations.gameId, r.gameId),
        eq(marketIdReservations.kind, r.kind),
        eq(marketIdReservations.marketId, r.from),
      ),
    )
  const stored = await getMarketIdReservation(db, r.gameId, r.kind)
  if (stored === null) throw new Error(`no market id stored for ${r.gameId} kind ${r.kind}`)
  return stored
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

/**
 * The slot of each market's newest indexed trade, for the markets that have one. The indexer
 * writes a market's cursor after its rows, so this is a lower bound of the cursor's slot.
 */
export async function latestTradeSlots(db: Db, marketKeys: string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>()
  if (marketKeys.length === 0) return out
  const rows = await db
    .select({ market: trades.market, slot: max(trades.slot) })
    .from(trades)
    .where(inArray(trades.market, marketKeys))
    .groupBy(trades.market)
  for (const row of rows) if (row.slot !== null) out.set(row.market, row.slot)
  return out
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

/** Statuses of a market that nobody has proposed an outcome for yet. */
const UNPROPOSED = ['open', 'halted']

/**
 * Markets past their `end_ts` with no proposal yet (open or halted): how many, and the `end_ts`
 * of the oldest. The health endpoint shows it as the resolution backlog.
 */
export async function unresolvedBacklog(
  db: Db,
  now: Date,
): Promise<{ count: number; oldestEndTs: Date | null }> {
  const rows = await db
    .select({ n: count(), oldest: min(markets.endTs) })
    .from(markets)
    .where(and(inArray(markets.status, UNPROPOSED), lt(markets.endTs, now)))
  const row = rows[0]
  return { count: Number(row?.n ?? 0), oldestEndTs: row?.oldest ?? null }
}
