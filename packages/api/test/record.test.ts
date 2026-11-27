// First-screen proof rail: GET /api/v1/record, the NBA winner markets created on chain and those
// with a final result. Practice markets never count.
import { upsertMarket, upsertScheduledGames } from '@horagon/db'
import { RecordSchema } from '@horagon/sdk'
import { HoragonClient } from '@horagon/sdk/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { makeEnv, type TestEnv } from './helpers'

let env: TestEnv
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  env = await makeEnv()
  app = createApp(env.deps)
})
afterEach(async () => {
  await env.h.close()
})

const get = (path: string) => app.request(`/api/v1${path}`)

/** A kind-0 market on `gameId`, created on chain, final when `final`. */
async function seedMarket(pubkey: string, gameId: string, final: boolean, kind = 0) {
  await upsertMarket(env.h.db, {
    pubkey,
    gameId,
    kind,
    marketId: `${kind}${pubkey.length}${pubkey.slice(0, 6)}`,
    gameMarketPda: `gm-${pubkey}`,
    yesMint: `yes-${pubkey}`,
    noMint: `no-${pubkey}`,
    initialPriceBps: 6000,
    endTs: new Date('2026-11-20T05:40:00Z'),
    seedAmount: 1_000_000_000n,
    status: final ? 'finalized' : 'open',
    createSig: `create-${pubkey}`,
    ...(final ? { finalizeSig: `finalize-${pubkey}` } : {}),
  })
}

async function seedGame(id: string, league: string) {
  await upsertScheduledGames(env.h.db, [
    {
      id,
      league,
      externalId: id.replace(/^\D+-/, ''),
      gameDate: '2026-11-19',
      home: 'CLE',
      away: 'MEM',
      scheduledTipoff: new Date('2026-11-20T01:00:00Z'),
      status: 'final',
      p0: 0.6,
    },
  ])
}

describe('GET /record', () => {
  it('counts nothing for a market the keeper never created on chain', async () => {
    // The seeded market has no create signature.
    const res = await get('/record')
    expect(res.status).toBe(200)
    expect(RecordSchema.parse(await res.json())).toEqual({ markets: 0, final: 0 })
  })

  it('counts NBA winner markets created and final, caches 60 s, and leaves Practice out', async () => {
    await seedGame('nba-401910001', 'NBA')
    await seedGame('nba-401910002', 'NBA')
    await seedGame('practice-401910007p0', 'PRACTICE')
    await seedMarket('NbaFinal1', 'nba-401910001', true)
    await seedMarket('NbaOpen22', 'nba-401910002', false)
    await seedMarket('NbaHalf33', 'nba-401910001', true, 1)
    await seedMarket('Practice4', 'practice-401910007p0', true)
    const res = await get('/record')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('s-maxage=60, stale-while-revalidate=60')
    expect(RecordSchema.parse(await res.json())).toEqual({ markets: 2, final: 1 })
    // Through the SDK client too.
    const client = new HoragonClient({
      baseUrl: 'http://horagon.test/api/v1',
      retries: 0,
      fetch: async (input, init) =>
        app.fetch(input instanceof Request ? input : new Request(input, init)),
    })
    expect(await client.record()).toEqual({ markets: 2, final: 1 })
  })
})
