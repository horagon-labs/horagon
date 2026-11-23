// The keeper's database client. Through the Supabase pooler in transaction mode (port 6543) a
// query pipelined behind another on the same connection is never answered, and a tick reads one
// draft per game with a market at once, more than the pool has connections: without
// `pipeline: false` that tick waits forever.
import { connectPostgres, type DbHandle } from '@horagon/db'

export function connectKeeperDb(url: string, opts: { max?: number } = {}): DbHandle {
  return connectPostgres(url, { ...opts, pipeline: false })
}
