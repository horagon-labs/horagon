// The SDK's HoragonClient against the real API app in-process: the wire contract both sides
// share, end to end, without a network.

import { Buffer } from 'node:buffer'
import { HoragonClient, HoragonError } from '@horagon/sdk'
import { VersionedTransaction } from '@solana/web3.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { GAME_ID, makeEnv, type TestEnv } from './helpers'

let env: TestEnv
let client: HoragonClient

beforeEach(async () => {
  env = await makeEnv()
  const app = createApp(env.deps)
  client = new HoragonClient({
    baseUrl: 'http://horagon.test/api/v1',
    fetch: ((input: string, init?: RequestInit) => app.request(input, init)) as typeof fetch,
    retries: 0,
  })
})
afterEach(async () => {
  await env.h.close()
})

describe('HoragonClient against the API', () => {
  it('reads games, a game and a market', async () => {
    const games = await client.games.list({ date: '2026-11-19' })
    expect(games.map((g) => g.id)).toEqual([GAME_ID])
    const detail = await client.games.get(GAME_ID)
    expect(detail.markets[0]?.pubkey).toBe(env.market.pubkey.toBase58())
    const state = await client.markets.get(env.market.pubkey.toBase58())
    expect(state.price).toBeGreaterThan(0)
  })

  it('quotes, builds, signs, submits and polls a sponsored trade', async () => {
    const req = {
      market: env.market.pubkey.toBase58(),
      side: 'home' as const,
      action: 'buy' as const,
      amount: '20',
    }
    const q = await client.quote(req)
    const built = await client.trade.build({ ...req, wallet: env.user.publicKey.toBase58() })
    expect(built.quote?.amountOut).toBe(q.amountOut)
    const tx = VersionedTransaction.deserialize(Buffer.from(built.tx, 'base64'))
    tx.sign([env.user])
    const sig = await client.trade.submit(Buffer.from(tx.serialize()).toString('base64'))
    env.chain.statuses.set(sig, {
      slot: 5,
      confirmations: null,
      err: null,
      confirmationStatus: 'confirmed',
    })
    await expect(client.trade.waitFor(sig, { pollMs: 1 })).resolves.toMatchObject({
      status: 'confirmed',
    })
  })

  it('turns problem+json into HoragonError with code and Retry-After', async () => {
    await expect(client.games.get('nba-999')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const wallet = env.user.publicKey.toBase58()
    await client.faucet(wallet)
    const err = await client.faucet(wallet).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HoragonError)
    expect(err).toMatchObject({ code: 'RATE_LIMITED' })
    expect((err as HoragonError).retryAfterSecs).toBeGreaterThan(0)
  })

  it('reports a degraded health instead of throwing', async () => {
    await expect(client.health()).resolves.toMatchObject({ ok: false })
  })
})
