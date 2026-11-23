// The keeper's one place to open its database. `connectPostgres` never pipelines by default
// (the Supabase pooler in transaction mode loses pipelined queries, and a tick reads one draft
// per game at once, more than the pool has connections), so this is a plain pass-through.
import { connectPostgres, type DbHandle } from '@horagon/db'

export function connectKeeperDb(url: string, opts: { max?: number } = {}): DbHandle {
  return connectPostgres(url, opts)
}
