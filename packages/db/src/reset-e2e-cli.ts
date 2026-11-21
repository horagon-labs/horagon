// `pnpm --filter @horagon/db db:reset-e2e`: empties the end-to-end database between runs.
// Runs only when the guard in reset-e2e.ts passes. Never prints a database URL, nor a driver
// error (those carry hosts and user names).
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectPostgres } from './client'
import {
  checkResetGuard,
  databaseUrlsFromEnvFile,
  describeResetError,
  truncateAll,
} from './reset-e2e'

const repoDir = join(fileURLToPath(import.meta.url), '../../../..')
const databaseUrl = process.env.DATABASE_URL
const guard = checkResetGuard({
  cluster: process.env.HORAGON_CLUSTER,
  resetFlag: process.env.HORAGON_E2E_RESET,
  databaseUrl,
  e2eUrls: databaseUrlsFromEnvFile(join(repoDir, '.env.e2e')),
  devnetUrls: databaseUrlsFromEnvFile(join(repoDir, '.env.devnet')),
})
if (!guard.ok || !databaseUrl) {
  console.error(`db:reset-e2e refused: ${guard.ok ? 'DATABASE_URL is not set' : guard.reason}`)
  process.exit(1)
}
try {
  const handle = connectPostgres(databaseUrl, { max: 1 })
  try {
    const n = await truncateAll(handle.db)
    console.log(`truncated ${n} tables`)
  } finally {
    // A failing close must not print or replace the original error.
    await handle.close().catch(() => {})
  }
} catch (err) {
  console.error(describeResetError(err))
  process.exit(1)
}
