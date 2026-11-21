// Real-Postgres concurrency check (Task 24, against the horagon-e2e Supabase project through
// its transaction pooler). Skipped unless HORAGON_IT_PG=1 and DATABASE_URL are both set; CI sets
// neither. Every row it writes carries a per-run prefix and is deleted in afterAll, so it can
// run against a database that holds e2e data.
import { randomBytes } from 'node:crypto'
import { like } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectPostgres, type DbHandle } from '../src/client'
import { rateLimitTake, sponsorReserve, sponsorSpentSince } from '../src/ops'
import { rateLimits, sponsorLog } from '../src/schema'

const url = process.env.DATABASE_URL
const enabled = process.env.HORAGON_IT_PG === '1' && !!url
const run = `it-pg-${randomBytes(6).toString('hex')}`

describe.skipIf(!enabled)('Postgres concurrency (real database)', () => {
  let handle: DbHandle

  beforeAll(() => {
    // max: 10 so the 20 calls below really run in parallel; prepare: false is set by connectPostgres.
    handle = connectPostgres(url as string, { max: 10 })
  })

  afterAll(async () => {
    try {
      await handle.db.delete(rateLimits).where(like(rateLimits.key, `${run}%`))
      await handle.db.delete(sponsorLog).where(like(sponsorLog.sig, `${run}%`))
    } finally {
      await handle.close()
    }
  })

  it('rate_limit_take: 20 parallel calls on one key with capacity 10 take exactly 10', async () => {
    const key = `${run}-rate`
    // A tiny refill keeps the bucket from topping up while the calls run.
    const waits = await Promise.all(
      Array.from({ length: 20 }, () =>
        rateLimitTake(handle.db, key, { capacity: 10, refillPerSec: 0.0001 }),
      ),
    )
    expect(waits.filter((w) => w === 0)).toHaveLength(10)
    expect(waits.filter((w) => w > 0)).toHaveLength(10)
  })

  it('sponsor_reserve: parallel reservations never pass the daily cap', async () => {
    const lamports = 1_000_000n
    const now = new Date()
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    // The cap covers the whole day's log, so leave room for exactly 10 on top of what is there.
    const before = await sponsorSpentSince(handle.db, dayStart)
    const cap = before + 10n * lamports
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        sponsorReserve(handle.db, {
          sig: `${run}-sig-${i}`,
          wallet: `${run}-wallet`,
          ipHash: `${run}-ip`,
          lamports,
          capLamports: cap,
        }),
      ),
    )
    expect(results.filter((r) => r === 'reserved')).toHaveLength(10)
    expect(results.filter((r) => r === 'over_cap')).toHaveLength(10)
    const after = await sponsorSpentSince(handle.db, dayStart)
    expect(after).toBeLessThanOrEqual(cap)
    expect(after - before).toBe(10n * lamports)
  })
})
