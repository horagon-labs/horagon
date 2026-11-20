// Migrations read SQL files next to the package, so they live apart from `client.ts`: the API
// bundle (Next.js on Vercel) imports the client and must not trace a folder it never reads.
import { fileURLToPath } from 'node:url'
import type { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js'
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url))

export async function migratePostgresDb(url: string): Promise<void> {
  const client = postgres(url, { prepare: false, max: 1 })
  try {
    await migratePostgres(drizzlePostgres(client), { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    await client.end({ timeout: 5 })
  }
}

export async function migratePgliteDb(pglite: PGlite): Promise<void> {
  await migratePglite(drizzlePglite(pglite), { migrationsFolder: MIGRATIONS_FOLDER })
}
