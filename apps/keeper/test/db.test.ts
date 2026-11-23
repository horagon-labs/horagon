import { connectPostgres, getDraft } from '@horagon/db'
import { transactionPooler } from '@horagon/db/test-support'
import { afterEach, describe, expect, it } from 'vitest'
import { connectKeeperDb } from '../src/db'

/** The tick reads one draft per game with a market at once: more than the pool's 5 connections. */
const fanOut = (db: Parameters<typeof getDraft>[0]) =>
  Promise.all(Array.from({ length: 12 }, (_, i) => getDraft(db, `nba-${i}e2e`)))

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))])

describe('the keeper database client through the Supabase transaction pooler', () => {
  // Run last first: the stand-in's sockets close before the client, so `close` never waits on
  // a query left unanswered.
  const cleanup: Array<() => unknown> = []
  afterEach(async () => {
    for (const f of cleanup.splice(0).reverse()) await f()
  })

  it('answers every query of a tick fan-out: nothing is pipelined', async () => {
    const pooler = await transactionPooler()
    const { db, close } = connectKeeperDb(pooler.url)
    cleanup.push(() => close(), pooler.close)

    expect(await within(fanOut(db), 3_000)).toEqual(Array(12).fill(null))
    expect(pooler.pipelined).toBe(0)
  })

  it('stand-in check: a client that pipelines (postgres.js 4 by default) waits forever', async () => {
    const pooler = await transactionPooler()
    const { db, close } = connectPostgres(pooler.url, { pipeline: true })
    cleanup.push(() => close(), pooler.close)

    expect(
      await within(
        fanOut(db).catch(() => 'failed'),
        2_000,
      ),
    ).toBe('hung')
    expect(pooler.pipelined).toBeGreaterThan(0)
  })
})
