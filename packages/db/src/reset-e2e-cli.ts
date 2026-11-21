// `pnpm --filter @horagon/db db:reset-e2e`: empties the end-to-end database between runs.
// Runs only when the guard in reset-e2e.ts passes. Never prints a database URL.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectPostgres } from './client'
import { checkResetGuard, databaseUrlFromEnvFile, truncateAll } from './reset-e2e'

const repoDir = join(fileURLToPath(import.meta.url), '../../../..')
const databaseUrl = process.env.DATABASE_URL
const guard = checkResetGuard({
  cluster: process.env.HORAGON_CLUSTER,
  resetFlag: process.env.HORAGON_E2E_RESET,
  databaseUrl,
  e2eUrl: databaseUrlFromEnvFile(join(repoDir, '.env.e2e')),
  devnetUrl: databaseUrlFromEnvFile(join(repoDir, '.env.devnet')),
})
if (!guard.ok || !databaseUrl) {
  console.error(`db:reset-e2e refused: ${guard.ok ? 'DATABASE_URL is not set' : guard.reason}`)
  process.exit(1)
}
const handle = connectPostgres(databaseUrl, { max: 1 })
try {
  const n = await truncateAll(handle.db)
  console.log(`truncated ${n} tables`)
} finally {
  await handle.close()
}
