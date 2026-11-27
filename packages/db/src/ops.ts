import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from 'drizzle-orm'
import { type Db, rowsOf } from './client'
import {
  keeperHeartbeats,
  opsEvents,
  rateLimits,
  sponsoredAtas,
  sponsorLog,
  trades,
  wallets,
} from './schema'

/** `closed_to` of an ATA that pm-AMM's claim_winnings closed (rent to the user, as expected). */
export const CLAIM_CLOSE = 'claim'

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
  const row = rowsOf<{ wait: number | string }>(res)[0]
  // Fail closed: a missing row must never read as "token taken".
  if (!row) throw new Error('rate_limit_take returned no row')
  const wait = Number(row.wait)
  return wait > 0 ? Math.ceil(wait) : 0
}

/**
 * Put `cost` tokens back into bucket `key` (at most up to `capacity`): a take whose action did
 * not happen, for a reason that was not the caller's. A bucket that does not exist is left alone.
 */
export async function rateLimitRefund(
  db: Db,
  key: string,
  opts: { cost?: number; capacity: number },
): Promise<void> {
  const cost = opts.cost ?? 1
  if (!(cost > 0) || !Number.isFinite(cost)) {
    throw new Error('rateLimitRefund: cost must be a finite number above 0')
  }
  await db
    .update(rateLimits)
    .set({
      tokens: sql`least(${opts.capacity}::double precision, ${rateLimits.tokens} + ${cost}::double precision)`,
    })
    .where(eq(rateLimits.key, key))
}

/**
 * 'duplicate': this signature already holds a reservation (the same signed transaction
 * submitted again), which is not counted twice.
 */
export type SponsorReservation = 'reserved' | 'over_cap' | 'duplicate'

/** Reserve the worst-case lamports of one sponsored tx under the daily cap (spec 9). */
export async function sponsorReserve(
  db: Db,
  r: { sig: string; wallet: string; ipHash: string; lamports: bigint; capLamports: bigint },
): Promise<SponsorReservation> {
  const res = await db.execute(
    sql`select sponsor_reserve(${r.sig}, ${r.wallet}, ${r.ipHash}, ${r.lamports.toString()}::bigint, ${r.capLamports.toString()}::bigint) as result`,
  )
  const result = rowsOf<{ result: string }>(res)[0]?.result
  if (result === 'reserved' || result === 'over_cap' || result === 'duplicate') return result
  // Fail closed: anything else must never read as "reserved".
  throw new Error('sponsor_reserve returned an unexpected result')
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

/**
 * True when the wallet has a sponsored transaction that landed: one of its `sponsor_log`
 * reservations is an indexed trade (the signature in `trades`). A reservation alone is not
 * history, nor is a trade the wallet paid for itself. Reads `trades_wallet_idx`, then the
 * `sponsor_log` primary key.
 */
export async function sponsoredTradeLanded(db: Db, wallet: string): Promise<boolean> {
  const rows = await db
    .select({ sig: trades.sig })
    .from(trades)
    .innerJoin(sponsorLog, eq(sponsorLog.sig, trades.sig))
    .where(eq(trades.wallet, wallet))
    .limit(1)
  return rows.length > 0
}

/**
 * ATAs a confirmed sponsored transaction created. One row per creation (`ata`, `createdSig`):
 * recording a creation twice changes nothing. An address can be created again after a close, so
 * for one `ata` only the newest creation may stay open; when a newer creation shows up, an older
 * open one is closed by inference (`closed_to = 'unknown'`, counted against the wallet). Order of
 * arrival does not matter: the end state is the same.
 */
export async function recordSponsoredAtas(
  db: Db,
  rows: ReadonlyArray<
    Pick<SponsoredAtaRow, 'ata' | 'wallet' | 'mint' | 'createdSig' | 'createdAt'>
  >,
): Promise<void> {
  if (rows.length === 0) return
  const byAta = new Map<string, typeof rows>()
  for (const r of rows) byAta.set(r.ata, [...(byAta.get(r.ata) ?? []), r])
  await db.transaction(async (tx) => {
    // Lock in sorted order: two recorders taking the same addresses can never deadlock.
    for (const ata of [...byAta.keys()].sort()) {
      const incoming = byAta.get(ata) ?? []
      // Serialise recorders of the same address (the partial unique index is the backstop).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ata}))`)
      const existing = await tx.select().from(sponsoredAtas).where(eq(sponsoredAtas.ata, ata))
      const known = new Set(existing.map((e) => e.createdSig))
      const fresh = new Map<string, (typeof rows)[number]>()
      for (const r of incoming) if (!known.has(r.createdSig)) fresh.set(r.createdSig, r)
      if (fresh.size === 0) continue
      const all = [
        ...existing.map((e) => ({ sig: e.createdSig, at: e.createdAt })),
        ...[...fresh.values()].map((r) => ({ sig: r.createdSig, at: r.createdAt })),
      ].sort((x, y) => x.at.getTime() - y.at.getTime() || (x.sig < y.sig ? -1 : 1))
      const nextCreation = new Map<string, Date>()
      all.forEach((c, i) => {
        const next = all[i + 1]
        if (next) nextCreation.set(c.sig, next.at)
      })
      // Close older open rows first, so the new open row never meets two open ones. A row closed
      // by inference earlier (closed at the time of a later creation) moves to the nearer next
      // creation when one arrives out of order; a real close is never touched.
      for (const e of existing) {
        const at = nextCreation.get(e.createdSig)
        if (!at) continue
        const closedByInference =
          e.closedAt !== null &&
          e.closedSig === null &&
          e.closedTo === 'unknown' &&
          all.some((c) => c.sig !== e.createdSig && c.at.getTime() === e.closedAt?.getTime())
        if (e.closedAt !== null && !(closedByInference && e.closedAt.getTime() !== at.getTime())) {
          continue
        }
        await tx
          .update(sponsoredAtas)
          .set({ closedSig: null, closedAt: at, closedTo: 'unknown', checkedAt: at })
          .where(
            and(
              eq(sponsoredAtas.ata, ata),
              eq(sponsoredAtas.createdSig, e.createdSig),
              or(
                isNull(sponsoredAtas.closedAt),
                and(isNull(sponsoredAtas.closedSig), eq(sponsoredAtas.closedTo, 'unknown')),
              ),
            ),
          )
      }
      await tx.insert(sponsoredAtas).values(
        [...fresh.values()].map((r) => {
          const at = nextCreation.get(r.createdSig)
          return at
            ? { ...r, closedSig: null, closedAt: at, closedTo: 'unknown', checkedAt: at }
            : r
        }),
      )
    }
  })
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
    .where(and(inArray(sponsoredAtas.ata, [...atas]), isNull(sponsoredAtas.closedAt)))
}

/**
 * Closes the open creation of `ata`; a no-op when there is none. With `createdSig`, only the open
 * row of that creation: a close found for an older creation never lands on a newer one recorded
 * in between.
 */
export async function markAtaClosed(
  db: Db,
  ata: string,
  c: { closedSig: string | null; closedAt: Date; closedTo: string; createdSig?: string },
): Promise<void> {
  const { createdSig, ...close } = c
  await db
    .update(sponsoredAtas)
    .set({ ...close, checkedAt: close.closedAt })
    .where(
      and(
        eq(sponsoredAtas.ata, ata),
        isNull(sponsoredAtas.closedAt),
        ...(createdSig !== undefined ? [eq(sponsoredAtas.createdSig, createdSig)] : []),
      ),
    )
}

/**
 * How many sponsor-paid ATAs `wallet` closed with the rent going anywhere but `sponsor`. A close
 * recorded as 'claim' (pm-AMM's claim_winnings, rent to the user) is expected and not counted.
 */
export async function atasClosedAway(db: Db, wallet: string, sponsor: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(sponsoredAtas)
    .where(
      and(
        eq(sponsoredAtas.wallet, wallet),
        isNotNull(sponsoredAtas.closedTo),
        ne(sponsoredAtas.closedTo, sponsor),
        ne(sponsoredAtas.closedTo, CLAIM_CLOSE),
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

/** The events of `actions` logged at or after `since`, oldest first (`ops_events_ts_idx`). */
export async function listOpsSince(db: Db, since: Date, actions: readonly string[]) {
  if (actions.length === 0) return []
  return db
    .select()
    .from(opsEvents)
    .where(and(gte(opsEvents.ts, since), inArray(opsEvents.action, [...actions])))
    .orderBy(asc(opsEvents.ts), asc(opsEvents.id))
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
