import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { type Db, rowsOf } from './client'
import { keeperHeartbeats, opsEvents, sponsoredAtas, sponsorLog, wallets } from './schema'

export type SponsoredAtaRow = typeof sponsoredAtas.$inferSelect

/**
 * Token bucket in Postgres (spec 19.3). Returns 0 when `cost` tokens were taken, otherwise
 * the seconds until they would be available (the `Retry-After` value).
 */
export async function rateLimitTake(
  db: Db,
  key: string,
  opts: { cost?: number; capacity: number; refillPerSec: number },
): Promise<number> {
  const res = await db.execute(
    sql`select rate_limit_take(${key}, ${opts.cost ?? 1}, ${opts.capacity}, ${opts.refillPerSec}) as wait`,
  )
  const wait = Number(rowsOf<{ wait: number | string }>(res)[0]?.wait ?? 0)
  return wait > 0 ? Math.ceil(wait) : 0
}

/** Reserve the worst-case lamports of one sponsored tx under the daily cap (spec 9). */
export async function sponsorReserve(
  db: Db,
  r: { sig: string; wallet: string; ipHash: string; lamports: bigint; capLamports: bigint },
): Promise<boolean> {
  const res = await db.execute(
    sql`select sponsor_reserve(${r.sig}, ${r.wallet}, ${r.ipHash}, ${r.lamports.toString()}::bigint, ${r.capLamports.toString()}::bigint) as ok`,
  )
  const ok = rowsOf<{ ok: boolean | string }>(res)[0]?.ok
  return ok === true || ok === 't' || ok === 'true'
}

/** Drop a reservation whose transaction never reached the network. */
export async function sponsorRelease(db: Db, sig: string): Promise<void> {
  await db.delete(sponsorLog).where(eq(sponsorLog.sig, sig))
}

export async function sponsorSpentSince(db: Db, since: Date): Promise<bigint> {
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${sponsorLog.lamports}), 0)` })
    .from(sponsorLog)
    .where(gte(sponsorLog.ts, since))
  return BigInt(rows[0]?.total ?? 0)
}

/** ATAs a confirmed sponsored transaction created; a known one is left as it is. */
export async function recordSponsoredAtas(
  db: Db,
  rows: ReadonlyArray<
    Pick<SponsoredAtaRow, 'ata' | 'wallet' | 'mint' | 'createdSig' | 'createdAt'>
  >,
): Promise<void> {
  if (rows.length === 0) return
  await db
    .insert(sponsoredAtas)
    .values([...rows])
    .onConflictDoNothing()
}

/** Open sponsored ATAs, the least recently checked first. */
export async function sponsoredAtasToCheck(db: Db, limit = 100): Promise<SponsoredAtaRow[]> {
  return db
    .select()
    .from(sponsoredAtas)
    .where(isNull(sponsoredAtas.closedAt))
    .orderBy(sql`${sponsoredAtas.checkedAt} asc nulls first`, asc(sponsoredAtas.createdAt))
    .limit(limit)
}

export async function markAtasChecked(db: Db, atas: readonly string[], at: Date): Promise<void> {
  if (atas.length === 0) return
  await db
    .update(sponsoredAtas)
    .set({ checkedAt: at })
    .where(inArray(sponsoredAtas.ata, [...atas]))
}

export async function markAtaClosed(
  db: Db,
  ata: string,
  c: { closedSig: string | null; closedAt: Date; closedTo: string },
): Promise<void> {
  await db
    .update(sponsoredAtas)
    .set({ ...c, checkedAt: c.closedAt })
    .where(eq(sponsoredAtas.ata, ata))
}

/** How many sponsor-paid ATAs `wallet` closed with the rent going anywhere but `sponsor`. */
export async function atasClosedAway(db: Db, wallet: string, sponsor: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(sponsoredAtas)
    .where(
      and(
        eq(sponsoredAtas.wallet, wallet),
        isNotNull(sponsoredAtas.closedTo),
        ne(sponsoredAtas.closedTo, sponsor),
      ),
    )
  return Number(rows[0]?.n ?? 0)
}

export async function heartbeat(
  db: Db,
  process: string,
  info: Record<string, unknown>,
): Promise<void> {
  const now = new Date()
  await db
    .insert(keeperHeartbeats)
    .values({ process, ts: now, info })
    .onConflictDoUpdate({ target: keeperHeartbeats.process, set: { ts: now, info } })
}

export async function getHeartbeat(db: Db, process: string) {
  const rows = await db.select().from(keeperHeartbeats).where(eq(keeperHeartbeats.process, process))
  return rows[0] ?? null
}

export interface OpsEvent {
  actor: string
  action: string
  gameId?: string | null
  market?: string | null
  sig?: string | null
  detail?: Record<string, unknown>
}

export async function logOps(db: Db, e: OpsEvent): Promise<void> {
  await db.insert(opsEvents).values({ ...e, detail: e.detail ?? {} })
}

export async function listOps(db: Db, limit = 100) {
  return db.select().from(opsEvents).orderBy(desc(opsEvents.ts), desc(opsEvents.id)).limit(limit)
}

/** Team wallets never count in metrics (spec 6.4); `ops` registers them. */
export async function setWalletKind(db: Db, pubkey: string, kind: 'human' | 'bot' | 'team') {
  await db
    .insert(wallets)
    .values({ pubkey, kind })
    .onConflictDoUpdate({ target: wallets.pubkey, set: { kind } })
}

export async function teamWallets(db: Db): Promise<string[]> {
  const rows = await db
    .select({ pubkey: wallets.pubkey })
    .from(wallets)
    .where(eq(wallets.kind, 'team'))
  return rows.map((r) => r.pubkey)
}
