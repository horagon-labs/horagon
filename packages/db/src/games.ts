import { and, asc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm'
import type { Db } from './client'
import {
  evidence,
  gameSnapshots,
  games,
  markets,
  type PeriodScores,
  resolutionDrafts,
} from './schema'

export type GameRow = typeof games.$inferSelect
export type MarketRow = typeof markets.$inferSelect
export type SnapshotRow = typeof gameSnapshots.$inferSelect
export type DraftRow = typeof resolutionDrafts.$inferSelect
export type GameWithMarkets = GameRow & { markets: MarketRow[] }

export interface ScheduledGame {
  id: string
  league: string
  externalId: string
  gameDate: string
  home: string
  away: string
  scheduledTipoff: Date
  status: string
  p0: number | null
}

/**
 * Insert or refresh the schedule fields of games. Never touches score fields, so a schedule
 * pass cannot roll back a live game; `featured` is set separately by the planner or ops.
 */
export async function upsertScheduledGames(db: Db, rows: ScheduledGame[]): Promise<void> {
  if (rows.length === 0) return
  await db
    .insert(games)
    .values(rows)
    .onConflictDoUpdate({
      target: games.id,
      set: {
        scheduledTipoff: sql`excluded.scheduled_tipoff`,
        gameDate: sql`excluded.game_date`,
        p0: sql`coalesce(excluded.p0, ${games.p0})`,
        // A schedule pass only moves a game between scheduled and postponed/canceled.
        status: sql`case when ${games.status} in ('live', 'final') then ${games.status} else excluded.status end`,
        updatedAt: sql`now()`,
      },
    })
}

export interface LiveState {
  status: string
  homeScore: number
  awayScore: number
  period: number
  clockSecs: number | null
  periods: PeriodScores
  modelProb: number | null
  feedUpdatedAt: Date
}

export async function updateGameLive(db: Db, id: string, s: LiveState): Promise<void> {
  await db
    .update(games)
    .set({ ...s, updatedAt: new Date() })
    .where(eq(games.id, id))
}

export async function setFeatured(db: Db, gameDate: string, ids: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(games).set({ featured: false }).where(eq(games.gameDate, gameDate))
    if (ids.length > 0) {
      await tx
        .update(games)
        .set({ featured: true })
        .where(and(eq(games.gameDate, gameDate), inArray(games.id, ids)))
    }
  })
}

async function withMarkets(db: Db, rows: GameRow[]): Promise<GameWithMarkets[]> {
  if (rows.length === 0) return []
  const ms = await db
    .select()
    .from(markets)
    .where(
      inArray(
        markets.gameId,
        rows.map((g) => g.id),
      ),
    )
    .orderBy(asc(markets.kind))
  return rows.map((g) => ({ ...g, markets: ms.filter((m) => m.gameId === g.id) }))
}

/** Games whose tip-off is in [from, to), optionally filtered by status, earliest first. */
export async function listGames(
  db: Db,
  q: { from: Date; to: Date; statuses?: string[] },
): Promise<GameWithMarkets[]> {
  const where = [gte(games.scheduledTipoff, q.from), lt(games.scheduledTipoff, q.to)]
  if (q.statuses && q.statuses.length > 0) where.push(inArray(games.status, q.statuses))
  const rows = await db
    .select()
    .from(games)
    .where(and(...where))
    .orderBy(asc(games.scheduledTipoff), asc(games.id))
  return withMarkets(db, rows)
}

export async function getGame(db: Db, id: string): Promise<GameWithMarkets | null> {
  const rows = await db.select().from(games).where(eq(games.id, id))
  return (await withMarkets(db, rows))[0] ?? null
}

/**
 * The games with these ids (duplicates and unknown ids ignored), each with its markets as
 * `getGame` returns it, earliest tip-off first. An empty list runs no query.
 */
export async function gamesByIds(db: Db, ids: readonly string[]): Promise<GameWithMarkets[]> {
  if (ids.length === 0) return []
  const rows = await db
    .select()
    .from(games)
    .where(inArray(games.id, [...new Set(ids)]))
    .orderBy(asc(games.scheduledTipoff), asc(games.id))
  return withMarkets(db, rows)
}

export async function insertSnapshot(db: Db, s: typeof gameSnapshots.$inferInsert): Promise<void> {
  await db.insert(gameSnapshots).values(s).onConflictDoNothing()
}

export async function listSnapshots(db: Db, gameId: string): Promise<SnapshotRow[]> {
  return db
    .select()
    .from(gameSnapshots)
    .where(eq(gameSnapshots.gameId, gameId))
    .orderBy(asc(gameSnapshots.ts))
}

/** The exact JCS string is stored, so the published bytes are the hashed bytes. */
export async function putEvidence(
  db: Db,
  e: { gameId: string; kind: number; json: string; hash: string },
): Promise<void> {
  await db
    .insert(evidence)
    .values(e)
    .onConflictDoUpdate({
      target: [evidence.gameId, evidence.kind],
      set: { json: e.json, hash: e.hash, createdAt: new Date() },
    })
}

export async function getEvidence(
  db: Db,
  gameId: string,
  kind: number,
): Promise<{ json: string; hash: string } | null> {
  const rows = await db
    .select({ json: evidence.json, hash: evidence.hash })
    .from(evidence)
    .where(and(eq(evidence.gameId, gameId), eq(evidence.kind, kind)))
  return rows[0] ?? null
}

/**
 * Write the draft of a game's result. A proposed draft is never overwritten; a pending or
 * rejected (challenged) one is replaced and goes back to pending, unalerted.
 */
export async function upsertDraft(db: Db, d: typeof resolutionDrafts.$inferInsert): Promise<void> {
  await db
    .insert(resolutionDrafts)
    .values(d)
    .onConflictDoUpdate({
      target: resolutionDrafts.gameId,
      set: {
        status: d.status,
        homeScore: d.homeScore,
        awayScore: d.awayScore,
        periods: d.periods,
        sourceUrl: d.sourceUrl,
        fetchedAt: d.fetchedAt,
        state: 'pending',
        alertedAt: null,
      },
      setWhere: ne(resolutionDrafts.state, 'proposed'),
    })
}

export async function getDraft(db: Db, gameId: string): Promise<DraftRow | null> {
  const rows = await db.select().from(resolutionDrafts).where(eq(resolutionDrafts.gameId, gameId))
  return rows[0] ?? null
}

export async function listDrafts(db: Db, state: string): Promise<DraftRow[]> {
  return db
    .select()
    .from(resolutionDrafts)
    .where(eq(resolutionDrafts.state, state))
    .orderBy(asc(resolutionDrafts.createdAt))
}

export async function setDraftState(
  db: Db,
  gameId: string,
  patch: { state?: string; alertedAt?: Date },
): Promise<void> {
  await db.update(resolutionDrafts).set(patch).where(eq(resolutionDrafts.gameId, gameId))
}
