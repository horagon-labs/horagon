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
 *
 * One query in flight per connection (`max_pipeline: 1`) unless the caller passes
 * `pipeline: true`. postgres.js 4 otherwise pipelines (up to 100) once more queries wait than
 * the pool has connections, and the transaction-mode pooler (port 6543) answers only the first
 * query of a pipelined burst; the others are never answered and wait forever. Every deployed
 * client goes through that pooler, so the safe value is the default. Opt in only for a direct
 * or session-mode connection.
 */
export function connectPostgres(
  url: string,
  opts: { max?: number; pipeline?: boolean } = {},
): DbHandle {
  const client = postgres(url, {
    prepare: false,
    max: opts.max ?? 5,
    idle_timeout: 20,
    ...(opts.pipeline === true ? {} : { max_pipeline: 1 }),
  })
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

/**
 * `db.execute` returns an array on postgres-js and `{ rows }` on PGlite. Any other shape throws:
 * callers such as the rate limiter must never read "no rows" out of a result they do not understand.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  const rows = (result as { rows?: unknown } | null | undefined)?.rows
  if (Array.isArray(rows)) return rows as T[]
  throw new Error('unrecognised query result shape')
}
