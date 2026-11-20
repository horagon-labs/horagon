import { connectPglite, type DbHandle } from './client'
import { migratePgliteDb } from './migrate'

/** A fresh, migrated, in-memory PGlite database for one test file. */
export async function createTestDb(): Promise<DbHandle> {
  const handle = connectPglite()
  await migratePgliteDb(handle.pglite)
  return handle
}
