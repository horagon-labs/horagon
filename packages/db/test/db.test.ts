import { type SQL, sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  atasClosedAway,
  countGames,
  type Db,
  type DbHandle,
  gamesByIds,
  getDraft,
  getEvidence,
  getGame,
  getHeartbeat,
  getMarketIdReservation,
  heartbeat,
  insertPricePoint,
  insertTrades,
  latestPrices,
  latestTradeSlots,
  listGames,
  listIndexableMarkets,
  listMarketTrades,
  listOps,
  listOpsSince,
  logOps,
  markAtaClosed,
  markAtasChecked,
  marketsByPubkeys,
  marketsByStatus,
  putEvidence,
  rateLimitRefund,
  rateLimitTake,
  recordSponsoredAtas,
  replaceMarketIdReservation,
  reserveMarketId,
  rowsOf,
  schema,
  setFeatured,
  setWalletKind,
  sponsoredAtasToCheck,
  sponsoredTradeLanded,
  sponsorRelease,
  sponsorReserve,
  sponsorSpentSince,
  teamWallets,
  unresolvedBacklog,
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
// Every test starts from empty tables, so each one is self-contained (run alone with -t, or reordered).
beforeEach(async () => {
  await h.db.execute(
    sql`truncate table evidence, game_snapshots, resolution_drafts, markets, market_id_reservations, games, trades, price_points, redeems_claims, wallets, sponsor_log, sponsored_atas, rate_limits, keeper_heartbeats, ops_events restart identity`,
  )
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
const market = (
  pubkey: string,
  gameId: string,
  over: Partial<ReturnType<typeof baseMarket>> = {},
) => ({ ...baseMarket(pubkey, gameId), ...over })
const baseMarket = (pubkey: string, gameId: string, kind = 0) => ({
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

const seedGames = async (...ids: string[]) =>
  upsertScheduledGames(
    h.db,
    ids.map((id) => game(id)),
  )

const TABLES = [
  'evidence',
  'flags',
  'game_snapshots',
  'games',
  'keeper_heartbeats',
  'market_id_reservations',
  'markets',
  'ops_events',
  'price_points',
  'rate_limits',
  'redeems_claims',
  'resolution_drafts',
  'sponsor_log',
  'sponsored_atas',
  'trades',
  'wallets',
]

describe('migrations', () => {
  it('create every Tier 1 table and both functions', async () => {
    const tables = rowsOf<{ table_name: string }>(
      await h.db.execute(
        sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
      ),
    ).map((r) => r.table_name)
    expect(tables).toEqual(TABLES)
    const fns = rowsOf<{ proname: string }>(
      await h.db.execute(
        sql`select proname from pg_proc where proname in ('rate_limit_take', 'sponsor_reserve') order by 1`,
      ),
    ).map((r) => r.proname)
    expect(fns).toEqual(['rate_limit_take', 'sponsor_reserve'])
  })
})

describe('rowsOf', () => {
  it('accepts a plain array (postgres-js) and { rows } (PGlite), and throws otherwise', () => {
    expect(rowsOf([{ a: 1 }])).toEqual([{ a: 1 }])
    expect(rowsOf({ rows: [{ a: 2 }] })).toEqual([{ a: 2 }])
    expect(() => rowsOf({})).toThrow(/unrecognised/)
    expect(() => rowsOf({ rows: 'x' })).toThrow(/unrecognised/)
    expect(() => rowsOf(null)).toThrow(/unrecognised/)
    expect(() => rowsOf(undefined)).toThrow(/unrecognised/)
  })
})

describe('games', () => {
  it('a schedule pass never rolls a live game back or erases its score', async () => {
    await seedGames('nba-1')
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
      game('nba-1'),
      game('nba-2', { scheduledTipoff: new Date('2026-11-20T02:00:00Z') }),
      game('nba-3', { scheduledTipoff: new Date('2026-11-22T02:00:00Z') }),
    ])
    await updateGameLive(h.db, 'nba-1', {
      status: 'live',
      homeScore: 1,
      awayScore: 0,
      period: 1,
      clockSecs: 600,
      periods: [],
      modelProb: null,
      feedUpdatedAt: new Date(),
    })
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

  it('filters listGames by league and counts the games of a league (R8)', async () => {
    await upsertScheduledGames(h.db, [
      game('nba-1'),
      game('practice-401910007p0', { league: 'PRACTICE', externalId: '401910007p0' }),
      game('practice-401910015p1', { league: 'PRACTICE', externalId: '401910015p1' }),
    ])
    const from = new Date(0)
    const to = new Date('2030-01-01')
    const ids = async (leagues?: string[]) =>
      (await listGames(h.db, { from, to, ...(leagues ? { leagues } : {}) })).map((g) => g.id)
    expect(await ids(['NBA'])).toEqual(['nba-1'])
    expect(await ids(['PRACTICE'])).toEqual(['practice-401910007p0', 'practice-401910015p1'])
    expect(await ids()).toHaveLength(3)
    expect(await ids([])).toHaveLength(3)
    expect(await countGames(h.db, 'PRACTICE')).toBe(2)
    expect(await countGames(h.db, 'NBA')).toBe(1)
    expect(await countGames(h.db, 'WNBA')).toBe(0)
  })

  it('gamesByIds reads the asked games with their markets, earliest tip-off first (R7)', async () => {
    await upsertScheduledGames(h.db, [
      game('nba-1', { scheduledTipoff: new Date('2026-11-20T02:00:00Z') }),
      game('nba-2'),
      game('nba-3'),
    ])
    await upsertMarket(h.db, market('M2', 'nba-2'))
    await upsertMarket(h.db, { ...baseMarket('M2h', 'nba-2', 1) })
    const rows = await gamesByIds(h.db, ['nba-1', 'nba-2', 'nba-9', 'nba-2'])
    expect(rows.map((g) => g.id)).toEqual(['nba-2', 'nba-1'])
    // The shape getGame returns, markets by kind.
    expect(rows[0]).toEqual(await getGame(h.db, 'nba-2'))
    expect(rows[0]?.markets.map((m) => m.pubkey)).toEqual(['M2', 'M2h'])
    expect(rows[1]?.markets).toEqual([])
  })

  it('gamesByIds runs no query for an empty list', async () => {
    const none = new Proxy({} as Db, {
      get() {
        throw new Error('no query expected')
      },
    })
    await expect(gamesByIds(none, [])).resolves.toEqual([])
  })

  it('setFeatured marks exactly the given games of that date', async () => {
    await seedGames('nba-1', 'nba-2')
    await setFeatured(h.db, '2026-11-19', ['nba-2'])
    await setFeatured(h.db, '2026-11-19', ['nba-1'])
    const rows = await listGames(h.db, { from: new Date(0), to: new Date('2030-01-01') })
    expect(rows.filter((g) => g.featured).map((g) => g.id)).toEqual(['nba-1'])
  })

  it('never overwrites a proposed draft, but replaces a rejected one', async () => {
    await seedGames('nba-1')
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
    await seedGames('nba-1')
    await putEvidence(h.db, { gameId: 'nba-1', kind: 0, json: '{"a":1}', hash: 'ab' })
    expect(await getEvidence(h.db, 'nba-1', 0)).toEqual({ json: '{"a":1}', hash: 'ab' })
    expect(await getEvidence(h.db, 'nba-1', 1)).toBeNull()
  })
})

const trade = (sig: string, over: Partial<Parameters<typeof insertTrades>[1][0]> = {}) => ({
  sig,
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
  ...over,
})

describe('markets and activity', () => {
  it('indexes markets until a day after recycling', async () => {
    await seedGames('nba-1', 'nba-2', 'nba-3')
    await upsertMarket(h.db, market('M1', 'nba-1'))
    await upsertMarket(h.db, market('M2', 'nba-2'))
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
    const t = trade('S1')
    await insertTrades(h.db, [t, t])
    await insertTrades(h.db, [t])
    const { trades } = await walletActivity(h.db, 'W1')
    expect(trades).toHaveLength(1)
    expect(trades[0]?.yesDelta).toBe(15_000_000n)
  })
})

describe('market queries', () => {
  it('finds markets by pubkey and by status, earliest end first', async () => {
    await seedGames('nba-1', 'nba-2', 'nba-3')
    const end = (hours: number) => new Date(tipoff.getTime() + hours * 3_600_000)
    await upsertMarket(h.db, market('M1', 'nba-1', { endTs: end(5) }))
    await upsertMarket(h.db, market('M2', 'nba-2', { endTs: end(9), status: 'recycled' }))
    await upsertMarket(h.db, market('M3', 'nba-3', { endTs: end(2), status: 'recycled' }))
    expect(await marketsByPubkeys(h.db, [])).toEqual([])
    expect((await marketsByPubkeys(h.db, ['M1', 'nope'])).map((m) => m.pubkey)).toEqual(['M1'])
    const recycled = await marketsByStatus(h.db, ['recycled'])
    expect(recycled.map((m) => m.pubkey)).toEqual(['M3', 'M2'])
    const everything = await marketsByStatus(h.db, ['open', 'recycled'])
    expect(everything.map((m) => m.pubkey)).toEqual(['M3', 'M1', 'M2'])
  })

  it('lists the trades of a market oldest first', async () => {
    expect(await listMarketTrades(h.db, [])).toEqual([])
    // Inserted newest first; read back oldest first.
    await insertTrades(h.db, [
      trade('S3', { blockTime: new Date('2026-11-20T03:00:00Z') }),
      trade('S1', { blockTime: new Date('2026-11-20T01:00:00Z') }),
      trade('S2', { blockTime: new Date('2026-11-20T02:00:00Z') }),
      trade('S9', { market: 'M9', blockTime: new Date('2026-11-20T00:00:00Z') }),
    ])
    const rows = await listMarketTrades(h.db, ['M1'])
    expect(rows.map((r) => r.sig)).toEqual(['S1', 'S2', 'S3'])
  })

  it('gives the slot of each market newest trade', async () => {
    expect(await latestTradeSlots(h.db, [])).toEqual(new Map())
    await insertTrades(h.db, [
      trade('S1', { slot: 7n }),
      trade('S2', { slot: 9n }),
      trade('S3', { slot: 8n }),
      trade('S9', { market: 'M9', slot: 100n }),
    ])
    expect(await latestTradeSlots(h.db, ['M1', 'M2'])).toEqual(new Map([['M1', 9n]]))
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

  it('lists the ops events of some actions since a time, oldest first', async () => {
    await logOps(h.db, { actor: 'api', action: 'sponsor-cap-50' })
    await logOps(h.db, { actor: 'keeper', action: 'create' })
    await logOps(h.db, { actor: 'api', action: 'sponsor-cap-80' })
    await h.db.execute(sql`update ops_events set ts = now() - interval '2 days' where id = 1`)
    await logOps(h.db, { actor: 'api', action: 'sponsor-cap-50' })
    const since = new Date(Date.now() - 3_600_000)
    const events = await listOpsSince(h.db, since, ['sponsor-cap-50', 'sponsor-cap-80'])
    expect(events.map((e) => [e.id, e.action])).toEqual([
      [3, 'sponsor-cap-80'],
      [4, 'sponsor-cap-50'],
    ])
  })

  it('registers team wallets, and a later kind replaces the earlier one', async () => {
    await setWalletKind(h.db, 'T1', 'team')
    await setWalletKind(h.db, 'T2', 'team')
    await setWalletKind(h.db, 'T2', 'bot')
    expect(await teamWallets(h.db)).toEqual(['T1'])
  })
})

describe('unresolvedBacklog', () => {
  it('counts the markets past end_ts with no proposal and the age of the oldest', async () => {
    const now = new Date('2026-11-21T00:00:00Z')
    expect(await unresolvedBacklog(h.db, now)).toEqual({ count: 0, oldestEndTs: null })
    await seedGames('nba-1', 'nba-2', 'nba-3', 'nba-4', 'nba-5')
    const at = (iso: string) => new Date(iso)
    await upsertMarket(h.db, market('M1', 'nba-1', { endTs: at('2026-11-20T22:00:00Z') }))
    await upsertMarket(
      h.db,
      market('M2', 'nba-2', { endTs: at('2026-11-20T20:00:00Z'), status: 'halted' }),
    )
    // Proposed or past it, or not over yet: not backlog.
    await upsertMarket(
      h.db,
      market('M3', 'nba-3', { endTs: at('2026-11-20T10:00:00Z'), status: 'proposed' }),
    )
    await upsertMarket(
      h.db,
      market('M4', 'nba-4', { endTs: at('2026-11-20T09:00:00Z'), status: 'finalized' }),
    )
    await upsertMarket(h.db, market('M5', 'nba-5', { endTs: at('2026-11-21T01:00:00Z') }))
    expect(await unresolvedBacklog(h.db, now)).toEqual({
      count: 2,
      oldestEndTs: at('2026-11-20T20:00:00Z'),
    })
  })

  it('counts a Practice market past end_ts too: the Practice process owes its proposal', async () => {
    const now = new Date('2026-11-21T00:00:00Z')
    await upsertScheduledGames(h.db, [
      game('practice-401910007p0', { league: 'PRACTICE', externalId: '401910007p0' }),
    ])
    await upsertMarket(
      h.db,
      market('P1', 'practice-401910007p0', {
        endTs: new Date('2026-11-20T23:00:00Z'),
        status: 'halted',
      }),
    )
    expect(await unresolvedBacklog(h.db, now)).toEqual({
      count: 1,
      oldestEndTs: new Date('2026-11-20T23:00:00Z'),
    })
  })
})

describe('market id reservations', () => {
  it('stores the first id for a game and kind, and hands that one back on a later reserve', async () => {
    await seedGames('nba-1')
    expect(await getMarketIdReservation(h.db, 'nba-1', 0)).toBeNull()
    expect(await reserveMarketId(h.db, { gameId: 'nba-1', kind: 0, marketId: '111' })).toBe('111')
    // A restart that drew another id gets the stored one: one market per game and kind.
    expect(await reserveMarketId(h.db, { gameId: 'nba-1', kind: 0, marketId: '222' })).toBe('111')
    expect(await getMarketIdReservation(h.db, 'nba-1', 0)).toBe('111')
    expect(await getMarketIdReservation(h.db, 'nba-1', 1)).toBeNull()
  })

  it('replaces only the id it was asked to replace', async () => {
    await seedGames('nba-1')
    await reserveMarketId(h.db, { gameId: 'nba-1', kind: 0, marketId: '111' })
    expect(
      await replaceMarketIdReservation(h.db, { gameId: 'nba-1', kind: 0, from: '111', to: '333' }),
    ).toBe('333')
    // A stale replace (another process replaced it first) keeps the current id.
    expect(
      await replaceMarketIdReservation(h.db, { gameId: 'nba-1', kind: 0, from: '111', to: '444' }),
    ).toBe('333')
    expect(await getMarketIdReservation(h.db, 'nba-1', 0)).toBe('333')
  })

  it('never stores one id for two games', async () => {
    await seedGames('nba-1', 'nba-2')
    await reserveMarketId(h.db, { gameId: 'nba-1', kind: 0, marketId: '111' })
    await expect(
      reserveMarketId(h.db, { gameId: 'nba-2', kind: 0, marketId: '111' }),
    ).rejects.toThrow()
  })
})

describe('latestPrices', () => {
  it('returns the newest point per market', async () => {
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
    const err = await rateLimitTake(h.db, 'k:d', { cost: 5, capacity: 1, refillPerSec: 1 }).then(
      () => null,
      (e: unknown) => e as { message: string; cause?: { message: string } },
    )
    expect(err).not.toBeNull()
    expect(`${err?.message} ${err?.cause?.message}`).toMatch(/rate_limit_take: bad arguments/)
  })

  it('throws instead of reporting "taken" when no row comes back', async () => {
    const fake = { execute: async () => ({ rows: [] }) } as unknown as DbHandle['db']
    await expect(rateLimitTake(fake, 'k:e', { capacity: 1, refillPerSec: 1 })).rejects.toThrow(
      /no row/,
    )
  })
})

describe('sponsor_reserve', () => {
  const r = { wallet: 'W', ipHash: 'h', lamports: 3_000_000n, capLamports: 7_000_000n }

  it('reserves under the daily cap, refuses past it, and frees on release', async () => {
    expect(await sponsorReserve(h.db, { ...r, sig: 'a' })).toBe('reserved')
    expect(await sponsorReserve(h.db, { ...r, sig: 'b' })).toBe('reserved')
    expect(await sponsorReserve(h.db, { ...r, sig: 'c' })).toBe('over_cap')
    await sponsorRelease(h.db, 'b')
    expect(await sponsorReserve(h.db, { ...r, sig: 'c' })).toBe('reserved')
    const startOfDay = new Date(new Date().toISOString().slice(0, 10))
    expect(await sponsorSpentSince(h.db, startOfDay)).toBe(6_000_000n)
  })

  it('does not count yesterday', async () => {
    expect(await sponsorReserve(h.db, { ...r, lamports: 7_000_000n, sig: 'old' })).toBe('reserved')
    await h.db.execute(sql`update sponsor_log set ts = now() - interval '2 days'`)
    expect(await sponsorReserve(h.db, { ...r, lamports: 7_000_000n, sig: 'd' })).toBe('reserved')
  })

  it('reports a signature already reserved as a duplicate and counts it once, even at the cap', async () => {
    expect(await sponsorReserve(h.db, { ...r, sig: 'a' })).toBe('reserved')
    expect(await sponsorReserve(h.db, { ...r, sig: 'a' })).toBe('duplicate')
    expect(await sponsorReserve(h.db, { ...r, sig: 'b' })).toBe('reserved')
    expect(await sponsorReserve(h.db, { ...r, sig: 'b' })).toBe('duplicate')
    expect(await sponsorSpentSince(h.db, new Date(0))).toBe(6_000_000n)
  })

  it('knows a wallet with a sponsored trade that landed before a given time', async () => {
    const today = new Date(new Date().toISOString().slice(0, 10))
    expect(await sponsoredTradeLanded(h.db, 'W1', today)).toBe(false)
    // Reserved and sent, but not (yet) indexed as a trade: not history.
    await sponsorReserve(h.db, { ...r, wallet: 'W1', sig: 'S1' })
    expect(await sponsoredTradeLanded(h.db, 'W1', today)).toBe(false)
    // A trade the wallet paid for itself is not a sponsored one.
    await insertTrades(h.db, [trade('S9', { wallet: 'W1' })])
    expect(await sponsoredTradeLanded(h.db, 'W1', today)).toBe(false)
    // Landed today: not history yet, or a burner's first trade would open the reserve to it.
    await insertTrades(h.db, [trade('S1', { wallet: 'W1' })])
    expect(await sponsoredTradeLanded(h.db, 'W1', today)).toBe(false)
    await h.db.execute(sql`update sponsor_log set ts = now() - interval '2 days' where sig = 'S1'`)
    expect(await sponsoredTradeLanded(h.db, 'W1', today)).toBe(true)
    expect(await sponsoredTradeLanded(h.db, 'W2', today)).toBe(false)
  })

  it('throws instead of guessing when the function returns something unexpected', async () => {
    const fake = { execute: async () => ({ rows: [{ result: 't' }] }) } as unknown as DbHandle['db']
    await expect(sponsorReserve(fake, { ...r, sig: 'x' })).rejects.toThrow(/unexpected/)
  })
})

describe('rateLimitRefund', () => {
  const opts = { capacity: 2, refillPerSec: 2 / 3600 }
  const tokens = async (key: string) =>
    rowsOf<{ tokens: number }>(
      await h.db.execute(sql`select tokens from rate_limits where key = ${key}`),
    )[0]?.tokens

  it('gives tokens back, never above capacity', async () => {
    expect(await rateLimitTake(h.db, 'k:r', opts)).toBe(0)
    expect(await rateLimitTake(h.db, 'k:r', opts)).toBe(0)
    expect(await rateLimitTake(h.db, 'k:r', opts)).toBeGreaterThan(0)
    await rateLimitRefund(h.db, 'k:r', { capacity: 2 })
    expect(await rateLimitTake(h.db, 'k:r', opts)).toBe(0)
    await rateLimitRefund(h.db, 'k:r', { cost: 5, capacity: 2 })
    expect(await tokens('k:r')).toBe(2)
  })

  it('does nothing for a bucket that does not exist, and refuses a cost of 0 or less', async () => {
    await rateLimitRefund(h.db, 'k:none', { capacity: 2 })
    expect(await tokens('k:none')).toBeUndefined()
    await expect(rateLimitRefund(h.db, 'k:r', { cost: 0, capacity: 2 })).rejects.toThrow(/cost/)
    await expect(rateLimitRefund(h.db, 'k:r', { cost: -1, capacity: 2 })).rejects.toThrow(/cost/)
  })
})

describe('sponsored ATAs', () => {
  const t = (min: number) => new Date(Date.UTC(2026, 10, 24, 1, min))
  const row = (ata: string, sig = `sig-${ata}`, min = 0, wallet = 'W') => ({
    ata,
    wallet,
    mint: 'M',
    createdSig: sig,
    createdAt: t(min),
  })
  const all = async () =>
    (await h.db.select().from(schema.sponsoredAtas)).sort(
      (a, b) => a.ata.localeCompare(b.ata) || a.createdAt.getTime() - b.createdAt.getTime(),
    )
  const open = async (ata: string) =>
    (await sponsoredAtasToCheck(h.db)).filter((r) => r.ata === ata)

  it('records each creation once and hands out the least recently checked first', async () => {
    await recordSponsoredAtas(h.db, [row('a'), row('b')])
    await recordSponsoredAtas(h.db, [row('a'), row('c')])
    await markAtasChecked(h.db, ['a'], t(60))
    const next = await sponsoredAtasToCheck(h.db, 2)
    expect(next.map((r) => r.ata).sort()).toEqual(['b', 'c'])
  })

  it('recording the same creation twice changes nothing, even with different data', async () => {
    await recordSponsoredAtas(h.db, [row('a'), row('a')])
    const before = await all()
    expect(before).toHaveLength(1)
    await recordSponsoredAtas(h.db, [{ ...row('a'), wallet: 'OTHER', mint: 'X', createdAt: t(30) }])
    expect(await all()).toEqual(before)
  })

  it('counts only closes whose rent went away from the sponsor', async () => {
    await recordSponsoredAtas(h.db, [row('a'), row('b'), row('c')])
    const closedAt = t(120)
    await markAtaClosed(h.db, 'a', { closedSig: 's1', closedAt, closedTo: 'SPONSOR' })
    expect(await atasClosedAway(h.db, 'W', 'SPONSOR')).toBe(0)
    await markAtaClosed(h.db, 'b', { closedSig: 's2', closedAt, closedTo: 'ELSEWHERE' })
    await markAtaClosed(h.db, 'c', { closedSig: null, closedAt, closedTo: 'unknown' })
    expect(await atasClosedAway(h.db, 'W', 'SPONSOR')).toBe(2)
    // A claim_winnings close ('claim': pm-AMM pays its rent to the user) is not counted either.
    await recordSponsoredAtas(h.db, [row('d')])
    await markAtaClosed(h.db, 'd', { closedSig: 's3', closedAt, closedTo: 'claim' })
    expect(await atasClosedAway(h.db, 'W', 'SPONSOR')).toBe(2)
    expect(await atasClosedAway(h.db, 'other', 'SPONSOR')).toBe(0)
    expect(await sponsoredAtasToCheck(h.db)).toEqual([])
  })

  it('watches an ATA created again after a close to the sponsor', async () => {
    await recordSponsoredAtas(h.db, [row('a', 'c1', 0)])
    await markAtaClosed(h.db, 'a', { closedSig: 'x1', closedAt: t(10), closedTo: 'SPONSOR' })
    await recordSponsoredAtas(h.db, [row('a', 'c2', 20)])
    expect((await open('a')).map((r) => r.createdSig)).toEqual(['c2'])
    expect(await atasClosedAway(h.db, 'W', 'SPONSOR')).toBe(0)
    await markAtaClosed(h.db, 'a', { closedSig: 'x2', closedAt: t(30), closedTo: 'ELSEWHERE' })
    expect(await atasClosedAway(h.db, 'W', 'SPONSOR')).toBe(1)
  })

  it('keeps a closed-away record when the ATA is created again', async () => {
    await recordSponsoredAtas(h.db, [row('a', 'c1', 0)])
    await markAtaClosed(h.db, 'a', { closedSig: 'x1', closedAt: t(10), closedTo: 'ELSEWHERE' })
    await recordSponsoredAtas(h.db, [row('a', 'c2', 20)])
    expect(await atasClosedAway(h.db, 'W', 'SPONSOR')).toBe(1)
    expect((await open('a')).map((r) => r.createdSig)).toEqual(['c2'])
  })

  it('closes by inference an open ATA that is created again', async () => {
    await recordSponsoredAtas(h.db, [row('a', 'c1', 0)])
    await recordSponsoredAtas(h.db, [row('a', 'c2', 20)])
    const rows = await all()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      createdSig: 'c1',
      closedTo: 'unknown',
      closedSig: null,
      closedAt: t(20),
    })
    expect(rows[1]).toMatchObject({ createdSig: 'c2', closedAt: null, closedTo: null })
    expect(await atasClosedAway(h.db, 'W', 'SPONSOR')).toBe(1)
    expect((await sponsoredAtasToCheck(h.db)).map((r) => r.createdSig)).toEqual(['c2'])
  })

  it('ends in the same state whatever order creations are recorded in', async () => {
    await recordSponsoredAtas(h.db, [row('a', 'c1', 0)])
    await recordSponsoredAtas(h.db, [row('a', 'c2', 20)])
    await recordSponsoredAtas(h.db, [row('a', 'c3', 40)])
    const inOrder = await all()
    await h.db.execute(sql`truncate table sponsored_atas`)
    await recordSponsoredAtas(h.db, [row('a', 'c3', 40)])
    await recordSponsoredAtas(h.db, [row('a', 'c1', 0)])
    await recordSponsoredAtas(h.db, [row('a', 'c2', 20)])
    expect(await all()).toEqual(inOrder)
    await h.db.execute(sql`truncate table sponsored_atas`)
    await recordSponsoredAtas(h.db, [row('a', 'c2', 20), row('a', 'c3', 40), row('a', 'c1', 0)])
    expect(await all()).toEqual(inOrder)
    expect(inOrder.filter((r) => r.closedAt === null).map((r) => r.createdSig)).toEqual(['c3'])
    expect(await atasClosedAway(h.db, 'W', 'SPONSOR')).toBe(2)
  })

  it('does not overwrite a real close when a newer creation arrives', async () => {
    await recordSponsoredAtas(h.db, [row('a', 'c1', 0)])
    await markAtaClosed(h.db, 'a', { closedSig: 'x1', closedAt: t(10), closedTo: 'SPONSOR' })
    await recordSponsoredAtas(h.db, [row('a', 'c2', 20)])
    const rows = await all()
    expect(rows[0]).toMatchObject({ closedSig: 'x1', closedTo: 'SPONSOR', closedAt: t(10) })
  })

  it('locks the ATAs of a batch in sorted order, so two recorders cannot deadlock', async () => {
    const dialect = new PgDialect()
    const locked: string[] = []
    const spy = new Proxy(h.db, {
      get(target, prop) {
        if (prop !== 'transaction') return Reflect.get(target, prop, target)
        return (fn: (tx: unknown) => Promise<unknown>) =>
          target.transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(t, p) {
                  const value = Reflect.get(t, p, t)
                  if (p !== 'execute') return typeof value === 'function' ? value.bind(t) : value
                  return (q: SQL) => {
                    const { sql: text, params } = dialect.sqlToQuery(q)
                    if (text.includes('pg_advisory_xact_lock')) locked.push(String(params[0]))
                    return t.execute(q)
                  }
                },
              }),
            ),
          )
      },
    })
    await recordSponsoredAtas(spy, [row('c'), row('a'), row('b'), row('a', 'sig-a2', 5)])
    expect(locked).toEqual(['a', 'b', 'c'])
  })

  it('markAtaClosed on an ATA with no open row changes nothing', async () => {
    await recordSponsoredAtas(h.db, [row('a', 'c1', 0)])
    await markAtaClosed(h.db, 'a', { closedSig: 'x1', closedAt: t(10), closedTo: 'SPONSOR' })
    const before = await all()
    await markAtaClosed(h.db, 'a', { closedSig: 'x2', closedAt: t(50), closedTo: 'ELSEWHERE' })
    await markAtaClosed(h.db, 'never-seen', {
      closedSig: null,
      closedAt: t(50),
      closedTo: 'unknown',
    })
    await markAtasChecked(h.db, ['a'], t(90))
    expect(await all()).toEqual(before)
    expect(await atasClosedAway(h.db, 'W', 'SPONSOR')).toBe(0)
  })

  it('markAtaClosed with a createdSig closes only that creation', async () => {
    await recordSponsoredAtas(h.db, [row('a', 'c1', 0)])
    // The close found for c1 arrives after c2 was recorded: it must not land on c2.
    await recordSponsoredAtas(h.db, [row('a', 'c2', 20)])
    await markAtaClosed(h.db, 'a', {
      closedSig: 'x1',
      closedAt: t(30),
      closedTo: 'ELSEWHERE',
      createdSig: 'c1',
    })
    expect((await open('a')).map((r) => r.createdSig)).toEqual(['c2'])
    const before = await all()
    expect(before[0]).toMatchObject({ createdSig: 'c1', closedTo: 'unknown', closedSig: null })
    // A matching guard closes the open row.
    await markAtaClosed(h.db, 'a', {
      closedSig: 'x2',
      closedAt: t(40),
      closedTo: 'SPONSOR',
      createdSig: 'c2',
    })
    expect(await open('a')).toEqual([])
    expect((await all())[1]).toMatchObject({ closedSig: 'x2', closedTo: 'SPONSOR' })
  })

  it('markAtaClosed with a createdSig that does not match changes nothing', async () => {
    await recordSponsoredAtas(h.db, [row('a', 'c1', 0)])
    const before = await all()
    await markAtaClosed(h.db, 'a', {
      closedSig: 'x1',
      closedAt: t(30),
      closedTo: 'ELSEWHERE',
      createdSig: 'older',
    })
    expect(await all()).toEqual(before)
    expect((await open('a')).map((r) => r.createdSig)).toEqual(['c1'])
    expect(await atasClosedAway(h.db, 'W', 'SPONSOR')).toBe(0)
  })
})
