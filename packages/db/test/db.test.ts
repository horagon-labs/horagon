import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  atasClosedAway,
  type DbHandle,
  getDraft,
  getEvidence,
  getGame,
  getHeartbeat,
  heartbeat,
  insertTrades,
  listGames,
  listIndexableMarkets,
  listMarketTrades,
  listOps,
  logOps,
  markAtaClosed,
  markAtasChecked,
  marketsByPubkeys,
  marketsByStatus,
  putEvidence,
  rateLimitTake,
  recordSponsoredAtas,
  rowsOf,
  setFeatured,
  setWalletKind,
  sponsoredAtasToCheck,
  sponsorRelease,
  sponsorReserve,
  sponsorSpentSince,
  teamWallets,
  updateGameLive,
  updateMarket,
  upsertDraft,
  upsertMarket,
  upsertScheduledGames,
  walletActivity,
} from '../src'
import { createTestDb } from '../src/testing'

let h: DbHandle
beforeAll(async () => {
  h = await createTestDb()
})
afterAll(async () => {
  await h.close()
})

const tipoff = new Date('2026-11-20T00:30:00Z')
const game = (id: string, over: Partial<Parameters<typeof upsertScheduledGames>[1][0]> = {}) => ({
  id,
  league: 'NBA',
  externalId: id.slice(4),
  gameDate: '2026-11-19',
  home: 'LAL',
  away: 'BOS',
  scheduledTipoff: tipoff,
  status: 'scheduled',
  p0: 0.6,
  ...over,
})
const market = (pubkey: string, gameId: string, kind = 0) => ({
  pubkey,
  gameId,
  kind,
  marketId: `${kind}${pubkey}`,
  gameMarketPda: `gm-${pubkey}`,
  yesMint: `yes-${pubkey}`,
  noMint: `no-${pubkey}`,
  initialPriceBps: 6000,
  endTs: new Date(tipoff.getTime() + 130 * 60_000),
  seedAmount: 1_000_000_000n,
  status: 'open',
})

describe('migrations', () => {
  it('create every Tier 1 table and both functions', async () => {
    const tables = rowsOf<{ table_name: string }>(
      await h.db.execute(
        sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
      ),
    ).map((r) => r.table_name)
    expect(tables).toEqual(
      expect.arrayContaining([
        'evidence',
        'game_snapshots',
        'games',
        'keeper_heartbeats',
        'markets',
        'ops_events',
        'price_points',
        'rate_limits',
        'redeems_claims',
        'resolution_drafts',
        'sponsor_log',
        'trades',
        'wallets',
      ]),
    )
    const fns = rowsOf<{ proname: string }>(
      await h.db.execute(
        sql`select proname from pg_proc where proname in ('rate_limit_take', 'sponsor_reserve') order by 1`,
      ),
    ).map((r) => r.proname)
    expect(fns).toEqual(['rate_limit_take', 'sponsor_reserve'])
  })
})

describe('games', () => {
  it('a schedule pass never rolls a live game back or erases its score', async () => {
    await upsertScheduledGames(h.db, [game('nba-1')])
    await updateGameLive(h.db, 'nba-1', {
      status: 'live',
      homeScore: 30,
      awayScore: 28,
      period: 2,
      clockSecs: 300,
      periods: [[30, 28]],
      modelProb: 0.55,
      feedUpdatedAt: new Date(),
    })
    await upsertScheduledGames(h.db, [game('nba-1', { status: 'scheduled', p0: null })])
    const g = await getGame(h.db, 'nba-1')
    expect(g).toMatchObject({ status: 'live', homeScore: 30, p0: 0.6, periods: [[30, 28]] })
  })

  it('lists games in a window with their markets, and filters by status', async () => {
    await upsertScheduledGames(h.db, [
      game('nba-2', { scheduledTipoff: new Date('2026-11-20T02:00:00Z') }),
      game('nba-3', { scheduledTipoff: new Date('2026-11-22T02:00:00Z') }),
    ])
    await upsertMarket(h.db, market('M2', 'nba-2'))
    const from = new Date('2026-11-19T12:00:00Z')
    const to = new Date('2026-11-20T12:00:00Z')
    const all = await listGames(h.db, { from, to })
    expect(all.map((g) => g.id)).toEqual(['nba-1', 'nba-2'])
    expect(all[1]?.markets.map((m) => m.pubkey)).toEqual(['M2'])
    expect((await listGames(h.db, { from, to, statuses: ['live'] })).map((g) => g.id)).toEqual([
      'nba-1',
    ])
  })

  it('setFeatured marks exactly the given games of that date', async () => {
    await setFeatured(h.db, '2026-11-19', ['nba-2'])
    await setFeatured(h.db, '2026-11-19', ['nba-1'])
    const rows = await listGames(h.db, { from: new Date(0), to: new Date('2030-01-01') })
    expect(rows.filter((g) => g.featured).map((g) => g.id)).toEqual(['nba-1'])
  })

  it('never overwrites a proposed draft, but replaces a rejected one', async () => {
    const d = {
      gameId: 'nba-1',
      status: 'final',
      homeScore: 101,
      awayScore: 99,
      periods: [
        [25, 25],
        [25, 25],
        [25, 25],
        [26, 24],
      ] as Array<[number, number]>,
      sourceUrl: 'https://site.api.espn.com/x',
      fetchedAt: new Date(),
    }
    await upsertDraft(h.db, d)
    await upsertDraft(h.db, { ...d, homeScore: 102 })
    expect((await getDraft(h.db, 'nba-1'))?.homeScore).toBe(102)
    await h.db.execute(sql`update resolution_drafts set state = 'proposed' where game_id = 'nba-1'`)
    await upsertDraft(h.db, { ...d, homeScore: 50 })
    expect((await getDraft(h.db, 'nba-1'))?.homeScore).toBe(102)
    // A challenge rejects it: the next draft replaces it and is pending, unalerted, again.
    await h.db.execute(
      sql`update resolution_drafts set state = 'rejected', alerted_at = now() where game_id = 'nba-1'`,
    )
    await upsertDraft(h.db, { ...d, homeScore: 103 })
    expect(await getDraft(h.db, 'nba-1')).toMatchObject({
      homeScore: 103,
      state: 'pending',
      alertedAt: null,
    })
  })

  it('stores evidence verbatim', async () => {
    await putEvidence(h.db, { gameId: 'nba-1', kind: 0, json: '{"a":1}', hash: 'ab' })
    expect(await getEvidence(h.db, 'nba-1', 0)).toEqual({ json: '{"a":1}', hash: 'ab' })
    expect(await getEvidence(h.db, 'nba-1', 1)).toBeNull()
  })
})

describe('markets and activity', () => {
  it('indexes markets until a day after recycling', async () => {
    await upsertMarket(h.db, market('M1', 'nba-1'))
    await upsertMarket(h.db, market('M3', 'nba-3'))
    const now = new Date('2026-11-21T00:00:00Z')
    await updateMarket(h.db, 'M3', {
      status: 'recycled',
      recycledAt: new Date('2026-11-19T00:00:00Z'),
    })
    await updateMarket(h.db, 'M2', {
      status: 'recycled',
      recycledAt: new Date('2026-11-20T12:00:00Z'),
    })
    const keys = (await listIndexableMarkets(h.db, now)).map((m) => m.pubkey).sort()
    expect(keys).toEqual(['M1', 'M2'])
  })

  it('ignores a duplicate trade (same sig and ix index)', async () => {
    const t = {
      sig: 'S1',
      ixIndex: 2,
      market: 'M1',
      wallet: 'W1',
      direction: 'usdcToYes',
      usdcAmount: 10_000_000n,
      usdcDelta: -10_000_000n,
      yesDelta: 15_000_000n,
      noDelta: 0n,
      fee: 200_000n,
      slot: 5n,
      blockTime: new Date('2026-11-20T01:00:00Z'),
    }
    await insertTrades(h.db, [t, t])
    await insertTrades(h.db, [t])
    const { trades } = await walletActivity(h.db, 'W1')
    expect(trades).toHaveLength(1)
    expect(trades[0]?.yesDelta).toBe(15_000_000n)
  })
})

describe('market queries', () => {
  it('finds markets by pubkey and by status, earliest end first', async () => {
    expect(await marketsByPubkeys(h.db, [])).toEqual([])
    expect((await marketsByPubkeys(h.db, ['M1', 'nope'])).map((m) => m.pubkey)).toEqual(['M1'])
    const recycled = await marketsByStatus(h.db, ['recycled'])
    expect(recycled.map((m) => m.pubkey).sort()).toEqual(['M2', 'M3'])
  })

  it('lists the trades of a market oldest first', async () => {
    expect(await listMarketTrades(h.db, [])).toEqual([])
    const rows = await listMarketTrades(h.db, ['M1'])
    expect(rows.map((r) => r.sig)).toEqual(['S1'])
  })
})

describe('ops tables', () => {
  it('keeps one heartbeat row per process, updated in place', async () => {
    expect(await getHeartbeat(h.db, 'keeper')).toBeNull()
    await heartbeat(h.db, 'keeper', { tick: 1 })
    await heartbeat(h.db, 'keeper', { tick: 2 })
    const hb = await getHeartbeat(h.db, 'keeper')
    expect(hb?.info).toEqual({ tick: 2 })
    const count = rowsOf<{ n: number }>(
      await h.db.execute(sql`select count(*)::int as n from keeper_heartbeats`),
    )
    expect(count[0]?.n).toBe(1)
  })

  it('lists ops events newest first', async () => {
    await logOps(h.db, { actor: 'keeper', action: 'create', gameId: 'nba-1', sig: 'A' })
    await logOps(h.db, { actor: 'guardian', action: 'propose', gameId: 'nba-1', detail: { s: 1 } })
    const events = await listOps(h.db, 2)
    expect(events.map((e) => e.action)).toEqual(['propose', 'create'])
    expect(events[1]?.detail).toEqual({})
  })

  it('registers team wallets, and a later kind replaces the earlier one', async () => {
    await setWalletKind(h.db, 'T1', 'team')
    await setWalletKind(h.db, 'T2', 'team')
    await setWalletKind(h.db, 'T2', 'bot')
    expect(await teamWallets(h.db)).toEqual(['T1'])
  })
})

describe('latestPrices', () => {
  it('returns the newest point per market', async () => {
    const { insertPricePoint, latestPrices } = await import('../src')
    await insertPricePoint(h.db, { market: 'M1', ts: new Date('2026-11-20T01:00:00Z'), price: 0.5 })
    await insertPricePoint(h.db, {
      market: 'M1',
      ts: new Date('2026-11-20T01:00:05Z'),
      price: 0.52,
    })
    await insertPricePoint(h.db, { market: 'M2', ts: new Date('2026-11-20T01:00:00Z'), price: 0.4 })
    const latest = await latestPrices(h.db, ['M1', 'M2', 'M9'])
    expect(latest.get('M1')?.price).toBe(0.52)
    expect(latest.get('M2')?.price).toBe(0.4)
    expect(latest.has('M9')).toBe(false)
  })
})

describe('rate_limit_take', () => {
  it('allows `capacity` takes, then reports the wait in whole seconds', async () => {
    const opts = { capacity: 3, refillPerSec: 3 / 3600 }
    for (let i = 0; i < 3; i++) expect(await rateLimitTake(h.db, 'k:a', opts)).toBe(0)
    const wait = await rateLimitTake(h.db, 'k:a', opts)
    expect(wait).toBeGreaterThan(1100)
    expect(wait).toBeLessThanOrEqual(1200)
    expect(await rateLimitTake(h.db, 'k:b', opts)).toBe(0)
  })

  it('refills with elapsed time', async () => {
    const opts = { capacity: 1, refillPerSec: 1 }
    expect(await rateLimitTake(h.db, 'k:c', opts)).toBe(0)
    await h.db.execute(
      sql`update rate_limits set updated_at = now() - interval '2 seconds' where key = 'k:c'`,
    )
    expect(await rateLimitTake(h.db, 'k:c', opts)).toBe(0)
  })

  it('rejects a cost above capacity', async () => {
    await expect(
      rateLimitTake(h.db, 'k:d', { cost: 5, capacity: 1, refillPerSec: 1 }),
    ).rejects.toThrow()
  })
})

describe('sponsor_reserve', () => {
  it('reserves under the daily cap, refuses past it, and frees on release', async () => {
    const r = { wallet: 'W', ipHash: 'h', lamports: 3_000_000n, capLamports: 7_000_000n }
    expect(await sponsorReserve(h.db, { ...r, sig: 'a' })).toBe(true)
    expect(await sponsorReserve(h.db, { ...r, sig: 'b' })).toBe(true)
    expect(await sponsorReserve(h.db, { ...r, sig: 'c' })).toBe(false)
    await sponsorRelease(h.db, 'b')
    expect(await sponsorReserve(h.db, { ...r, sig: 'c' })).toBe(true)
    const startOfDay = new Date(new Date().toISOString().slice(0, 10))
    expect(await sponsorSpentSince(h.db, startOfDay)).toBe(6_000_000n)
  })

  it('does not count yesterday', async () => {
    await h.db.execute(sql`update sponsor_log set ts = now() - interval '2 days'`)
    const r = { wallet: 'W', ipHash: 'h', lamports: 7_000_000n, capLamports: 7_000_000n, sig: 'd' }
    expect(await sponsorReserve(h.db, r)).toBe(true)
  })
})

describe('sponsored ATAs', () => {
  const at = new Date('2026-11-24T01:00:00Z')
  const row = (ata: string, wallet = 'W') => ({
    ata,
    wallet,
    mint: 'M',
    createdSig: `sig-${ata}`,
    createdAt: at,
  })

  it('records each ATA once and hands out the least recently checked first', async () => {
    await recordSponsoredAtas(h.db, [row('a'), row('b')])
    await recordSponsoredAtas(h.db, [row('a'), row('c')])
    await markAtasChecked(h.db, ['a'], new Date('2026-11-24T02:00:00Z'))
    const next = await sponsoredAtasToCheck(h.db, 2)
    expect(next.map((r) => r.ata).sort()).toEqual(['b', 'c'])
  })

  it('counts only closes whose rent went away from the sponsor', async () => {
    const closedAt = new Date('2026-11-24T03:00:00Z')
    await markAtaClosed(h.db, 'a', { closedSig: 's1', closedAt, closedTo: 'SPONSOR' })
    expect(await atasClosedAway(h.db, 'W', 'SPONSOR')).toBe(0)
    await markAtaClosed(h.db, 'b', { closedSig: 's2', closedAt, closedTo: 'ELSEWHERE' })
    await markAtaClosed(h.db, 'c', { closedSig: null, closedAt, closedTo: 'unknown' })
    expect(await atasClosedAway(h.db, 'W', 'SPONSOR')).toBe(2)
    expect(await atasClosedAway(h.db, 'other', 'SPONSOR')).toBe(0)
    expect(await sponsoredAtasToCheck(h.db)).toEqual([])
  })
})
