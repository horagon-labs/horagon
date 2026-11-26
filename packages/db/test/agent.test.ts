import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type DbHandle,
  insertClaims,
  insertTrades,
  lastOtherTrades,
  listAgentMarkets,
  updateGameLive,
  upsertMarket,
  upsertScheduledGames,
  walletClaimableMarkets,
  walletMarketTotals,
} from '../src'
import { createTestDb } from '../src/testing'

let h: DbHandle
beforeAll(async () => {
  h = await createTestDb()
})
beforeEach(async () => {
  await h.db.execute(
    sql`truncate table trades, redeems_claims, markets, game_snapshots, resolution_drafts, evidence, games cascade`,
  )
})
afterAll(async () => {
  await h.close()
})

const TIP = new Date('2026-11-27T00:00:00Z')
const AGENT = 'AGENT'

async function game(id: string, league: string, status: string, modelProb: number | null) {
  await upsertScheduledGames(h.db, [
    {
      id,
      league,
      externalId: id,
      gameDate: '2026-11-26',
      home: 'CLE',
      away: 'MEM',
      scheduledTipoff: TIP,
      status: 'scheduled',
      p0: 0.6,
    },
  ])
  if (status !== 'scheduled') {
    await updateGameLive(h.db, id, {
      status,
      homeScore: 10,
      awayScore: 8,
      period: 1,
      clockSecs: 300,
      periods: [],
      modelProb,
      feedUpdatedAt: new Date('2026-11-27T00:10:00Z'),
    })
  }
}

async function market(pubkey: string, gameId: string, kind: number, status: string) {
  await upsertMarket(h.db, {
    pubkey,
    gameId,
    kind,
    marketId: `${pubkey}-id`,
    gameMarketPda: `${pubkey}-gm`,
    yesMint: `${pubkey}-y`,
    noMint: `${pubkey}-n`,
    initialPriceBps: 6000,
    endTs: new Date(TIP.getTime() + 10_800_000),
    seedAmount: 300_000_000n,
    status,
  })
}

let n = 0
const trade = (market: string, wallet: string, at: string, direction = 'usdcToYes', usdc = 5n) => ({
  sig: `sig${n++}`,
  ixIndex: 3,
  market,
  wallet,
  direction,
  usdcAmount: usdc,
  usdcDelta: direction.startsWith('usdcTo') ? -usdc : usdc,
  yesDelta: 1n,
  noDelta: 0n,
  fee: 0n,
  slot: 1n,
  blockTime: new Date(at),
  botMemo: wallet === AGENT,
})

describe('listAgentMarkets', () => {
  it('lists open winner markets of live games in the leagues asked for', async () => {
    await game('nba-1', 'NBA', 'live', 0.7)
    await game('nba-2', 'NBA', 'scheduled', null)
    await game('nba-3', 'NBA', 'final', 1)
    await game('p-1', 'PRACTICE', 'live', 0.4)
    await market('M1', 'nba-1', 0, 'open')
    await market('M1h', 'nba-1', 1, 'open')
    await market('M2', 'nba-2', 0, 'open')
    await market('M3', 'nba-3', 0, 'halted')
    await market('P1', 'p-1', 0, 'open')
    const nba = await listAgentMarkets(h.db, ['NBA'])
    expect(nba.map((m) => m.pubkey)).toEqual(['M1'])
    expect(nba[0]).toMatchObject({
      gameId: 'nba-1',
      kind: 0,
      status: 'open',
      league: 'NBA',
      gameStatus: 'live',
      period: 1,
      clockSecs: 300,
      modelProb: 0.7,
      feedUpdatedAt: new Date('2026-11-27T00:10:00Z'),
      scheduledTipoff: TIP,
    })
    expect((await listAgentMarkets(h.db, ['NBA', 'PRACTICE'])).map((m) => m.pubkey)).toEqual([
      'M1',
      'P1',
    ])
    expect(await listAgentMarkets(h.db, [])).toEqual([])
  })
})

describe('trade reads', () => {
  it('finds the newest trade of other wallets since a time, per market', async () => {
    await insertTrades(h.db, [
      trade('M1', 'FAN', '2026-11-27T00:20:00Z'),
      trade('M1', 'FAN', '2026-11-27T00:21:00Z'),
      trade('M1', AGENT, '2026-11-27T00:22:00Z'),
      trade('M2', AGENT, '2026-11-27T00:22:00Z'),
      trade('M3', 'FAN', '2026-11-27T00:05:00Z'),
    ])
    const since = new Date('2026-11-27T00:10:00Z')
    const last = await lastOtherTrades(h.db, ['M1', 'M2', 'M3'], AGENT, since)
    expect([...last.entries()]).toEqual([['M1', new Date('2026-11-27T00:21:00Z')]])
    expect((await lastOtherTrades(h.db, [], AGENT, since)).size).toBe(0)
  })

  it("sums a wallet's buys and counts its swaps per market", async () => {
    await insertTrades(h.db, [
      trade('M1', AGENT, '2026-11-27T00:20:00Z', 'usdcToYes', 100_000_000n),
      trade('M1', AGENT, '2026-11-27T00:21:00Z', 'usdcToNo', 50_000_000n),
      trade('M1', AGENT, '2026-11-27T00:22:00Z', 'yesToUsdc', 7_000_000n),
      trade('M1', 'FAN', '2026-11-27T00:22:00Z', 'usdcToYes', 999_000_000n),
      trade('M2', AGENT, '2026-11-27T00:22:00Z', 'usdcToYes', 1_000_000n),
    ])
    const totals = await walletMarketTotals(h.db, AGENT, ['M1', 'M2', 'M9'])
    expect(totals.get('M1')).toEqual({ spent: 150_000_000n, swaps: 3 })
    expect(totals.get('M2')).toEqual({ spent: 1_000_000n, swaps: 1 })
    expect(totals.has('M9')).toBe(false)
    expect((await walletMarketTotals(h.db, AGENT, [])).size).toBe(0)
  })

  it('lists settled markets the wallet traded and has not claimed', async () => {
    await game('nba-1', 'NBA', 'final', 1)
    await market('M1', 'nba-1', 0, 'finalized')
    await market('M2', 'nba-1', 1, 'recycled')
    await market('M3', 'nba-1', 0, 'proposed')
    await market('M4', 'nba-1', 0, 'finalized')
    await market('M5', 'nba-1', 0, 'finalized')
    await insertTrades(h.db, [
      trade('M1', AGENT, '2026-11-27T00:20:00Z'),
      trade('M2', AGENT, '2026-11-27T00:20:00Z'),
      trade('M3', AGENT, '2026-11-27T00:20:00Z'),
      trade('M4', 'FAN', '2026-11-27T00:20:00Z'),
      trade('M5', AGENT, '2026-11-27T00:20:00Z'),
    ])
    await insertClaims(h.db, [
      {
        sig: 'claim1',
        ixIndex: 2,
        market: 'M5',
        wallet: AGENT,
        kind: 'claim',
        usdcAmount: 1n,
        yesDelta: -1n,
        noDelta: 0n,
        blockTime: new Date('2026-11-27T03:00:00Z'),
      },
    ])
    expect(await walletClaimableMarkets(h.db, AGENT)).toEqual([
      { pubkey: 'M1', gameId: 'nba-1' },
      { pubkey: 'M2', gameId: 'nba-1' },
    ])
  })
})
