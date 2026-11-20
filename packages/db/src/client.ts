import { PGlite } from '@electric-sql/pglite'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

/** One type for both drivers: every query in this package takes a `Db`. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>

export interface DbHandle {
  db: Db
  close(): Promise<void>
}

/**
 * Postgres (Supabase). `prepare: false` because Supabase's pooler runs in transaction mode;
 * `max` stays small since Vercel functions open one client each.
 */
export function connectPostgres(url: string, opts: { max?: number } = {}): DbHandle {
  const client = postgres(url, { prepare: false, max: opts.max ?? 5, idle_timeout: 20 })
  return {
    db: drizzlePostgres(client, { schema }) as unknown as Db,
    close: () => client.end({ timeout: 5 }),
  }
}

/** PGlite: in memory when `dataDir` is omitted (tests, sandbox), or a directory on disk. */
export function connectPglite(dataDir?: string): DbHandle & { pglite: PGlite } {
  const pglite = new PGlite(dataDir)
  return {
    pglite,
    db: drizzlePglite(pglite, { schema }) as unknown as Db,
    close: () => pglite.close(),
  }
}

/** `db.execute` returns an array on postgres-js and `{ rows }` on PGlite. */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  const rows = (result as { rows?: unknown }).rows
  return Array.isArray(rows) ? (rows as T[]) : []
}
