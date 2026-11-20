// `pnpm --filter @horagon/db db:migrate`: applies migrations/ to DATABASE_URL (Supabase).
import { migratePostgresDb } from './migrate'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}
await migratePostgresDb(url)
console.log('migrations applied')
