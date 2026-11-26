import {
  insertPricePoint,
  insertSnapshot,
  insertTrades,
  setFlag,
  updateGameLive,
  upsertMarket,
  upsertScheduledGames,
} from '@horagon/db'
import { MeResponseSchema, PositionsResponseSchema } from '@horagon/sdk'
import { Keypair } from '@solana/web3.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { callModel, meNight, meStatus, modelAt, scoreCall, vsPoints } from '../src/me'
import { configAccount } from './config-account'
import { makeEnv, program, type TestEnv } from './helpers'

const secs = (iso: string) => Date.parse(iso) / 1000
const at = (iso: string) => new Date(iso)
/** 9:00 PM ET on the ET night 2026-11-28 (a Saturday). */
const NOW = secs('2026-11-29T02:00:00Z')
/** 7:30 PM ET on 2026-11-28. */
const TIP = '2026-11-29T00:30:00Z'
const U = 1_000_000n

describe('meNight: the night rolls over at 06:00 ET', () => {
  it('in winter (EST)', () => {
    expect(meNight(secs('2026-11-29T10:59:59Z'))).toBe('2026-11-28')
    expect(meNight(secs('2026-11-29T11:00:00Z'))).toBe('2026-11-29')
  })

  it('in summer (EDT), on a day with no clock change', () => {
    expect(meNight(secs('2026-06-10T09:59:59Z'))).toBe('2026-06-09')
    expect(meNight(secs('2026-06-10T10:00:00Z'))).toBe('2026-06-10')
  })
})

describe('meStatus', () => {
  const end = at('2026-11-29T03:40:00Z')
  const m = (status: string) => ({ status, endTs: end })
  const before = secs('2026-11-29T03:00:00Z')

  it('maps a result first: final, then challenged, then proposed', () => {
    expect(meStatus(m('finalized'), { status: 'final' }, before)).toBe('final')
    expect(meStatus(m('recycled'), { status: 'postponed' }, before)).toBe('final')
    expect(meStatus(m('challenged'), { status: 'final' }, before)).toBe('challenged')
    expect(meStatus(m('proposed'), { status: 'final' }, before)).toBe('proposed')
  })

  it('is closed once the game is final, the market halted, or end_ts has passed', () => {
    // An open market on a final game is closed: the final buzzer closes it everywhere.
    expect(meStatus(m('open'), { status: 'final' }, before)).toBe('closed')
    expect(meStatus(m('halted'), { status: 'live' }, before)).toBe('closed')
    expect(meStatus(m('open'), { status: 'live' }, secs('2026-11-29T03:40:00Z'))).toBe('closed')
  })

  it('is open otherwise', () => {
    expect(meStatus(m('open'), { status: 'live' }, before)).toBe('open')
    expect(meStatus(m('open'), { status: 'scheduled' }, before)).toBe('open')
  })
})

describe('the model at the time of a call', () => {
  const snaps = [
    { ts: at('2026-11-29T01:00:00Z'), modelProb: 0.6 },
    { ts: at('2026-11-29T01:10:00Z'), modelProb: 0.7 },
  ]

  it('is the newest snapshot at or before the buy, never a later one', () => {
    expect(modelAt(snaps, at('2026-11-29T01:05:00Z'), 0.5)).toBe(0.6)
    expect(modelAt(snaps, at('2026-11-29T01:10:00Z'), 0.5)).toBe(0.7)
    expect(modelAt(snaps, at('2026-11-29T01:09:59Z'), 0.5)).toBe(0.6)
  })

  it('is p0 before the first snapshot, and null when there is none', () => {
    expect(modelAt(snaps, at('2026-11-29T00:59:59Z'), 0.55)).toBe(0.55)
    expect(modelAt([], at('2026-11-29T00:59:59Z'), null)).toBeNull()
    expect(modelAt([{ ts: at('2026-11-29T00:00:00Z'), modelProb: null }], at(TIP), 0.5)).toBeNull()
  })

  it('takes 1 - m for the away side, weighted by the shares each buy gained', () => {
    const buy = (iso: string, shares: bigint) => ({ at: at(iso), shares })
    expect(callModel([buy('2026-11-29T01:05:00Z', 10n * U)], 'home', snaps, 0.5)).toBe(0.6)
    expect(callModel([buy('2026-11-29T01:05:00Z', 10n * U)], 'away', snaps, 0.5)).toBeCloseTo(0.4)
    const two = [buy('2026-11-29T01:05:00Z', 10n * U), buy('2026-11-29T01:15:00Z', 30n * U)]
    expect(callModel(two, 'home', snaps, 0.5)).toBeCloseTo((10 * 0.6 + 30 * 0.7) / 40)
  })

  it('is null without a buy, or when any buy had no model', () => {
    expect(callModel([], 'home', snaps, 0.5)).toBeNull()
    expect(
      callModel(
        [
          { at: at('2026-11-29T01:05:00Z'), shares: U },
          { at: at('2026-11-29T00:00:00Z'), shares: U },
        ],
        'home',
        snaps,
        null,
      ),
    ).toBeNull()
  })
})

describe('points against the model', () => {
  it('scores a call: +38 for a win at 62%, -62 for a loss', () => {
    expect(scoreCall(0.62, 'won')).toBe(38)
    expect(scoreCall(0.62, 'lost')).toBe(-62)
    expect(scoreCall(0.62, null)).toBeNull()
    expect(scoreCall(null, 'won')).toBeNull()
  })

  it('sums the night first, then rounds', () => {
    // Each call alone rounds to 67 (66.5); the night is 133, not 134.
    const calls = [
      { model: 0.335, result: 'won' as const },
      { model: 0.335, result: 'won' as const },
    ]
    expect(calls.map((c) => scoreCall(c.model, c.result))).toEqual([67, 67])
    expect(vsPoints(calls)).toBe(133)
  })

  it('is null with nothing settled', () => {
    expect(vsPoints([])).toBeNull()
    expect(vsPoints([{ model: 0.5, result: null }])).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// The route, over PGlite.

let env: TestEnv
let app: ReturnType<typeof createApp>
let wallet: string
let seq = 0

beforeEach(async () => {
  env = await makeEnv()
  env.deps.now = () => NOW
  app = createApp(env.deps)
  wallet = Keypair.generate().publicKey.toBase58()
})
afterEach(async () => {
  await env.h.close()
})

const flagOn = () => setFlag(env.h.db, 'FLAG_ME', true, 'test')
const get = (path: string, a = app) => a.request(`/api/v1${path}`)
async function me(query = '', a = app) {
  const res = await get(`/me/${wallet}${query}`, a)
  expect(res.status).toBe(200)
  return MeResponseSchema.parse(await res.json())
}
const key = () => Keypair.generate().publicKey.toBase58()

async function addGame(
  id: string,
  over: Partial<Parameters<typeof upsertScheduledGames>[1][0]> = {},
): Promise<string> {
  await upsertScheduledGames(env.h.db, [
    {
      id,
      league: 'NBA',
      externalId: id.slice(4),
      gameDate: '2026-11-28',
      home: 'MEM',
      away: 'LAC',
      scheduledTipoff: at(TIP),
      status: 'scheduled',
      p0: 0.55,
      ...over,
    },
  ])
  return id
}

async function play(id: string, status: string, home = 0, away = 0) {
  await updateGameLive(env.h.db, id, {
    status,
    homeScore: home,
    awayScore: away,
    period: status === 'final' ? 4 : 3,
    clockSecs: status === 'final' ? 0 : 300,
    periods: [],
    modelProb: null,
    feedUpdatedAt: at(TIP),
  })
}

async function addMarket(
  gameId: string,
  over: Partial<Parameters<typeof upsertMarket>[1]> = {},
): Promise<string> {
  const pubkey = key()
  seq++
  await upsertMarket(env.h.db, {
    pubkey,
    gameId,
    kind: 0,
    marketId: String(10_000 + seq),
    gameMarketPda: key(),
    yesMint: key(),
    noMint: key(),
    initialPriceBps: 5500,
    endTs: at('2026-11-29T03:40:00Z'),
    seedAmount: 1_000n * U,
    status: 'open',
    ...over,
  })
  return pubkey
}

/** A swap of the wallet: mUSDC in (negative) for YES (home) or NO (away) shares. */
async function swap(
  market: string,
  when: string,
  d: { usdc: bigint; yes?: bigint; no?: bigint },
  who = wallet,
) {
  seq++
  await insertTrades(env.h.db, [
    {
      sig: `s${seq}`.padEnd(88, 'x'),
      ixIndex: 0,
      market,
      wallet: who,
      direction: 'x',
      usdcAmount: d.usdc < 0n ? -d.usdc : d.usdc,
      usdcDelta: d.usdc,
      yesDelta: d.yes ?? 0n,
      noDelta: d.no ?? 0n,
      fee: 0n,
      slot: BigInt(seq),
      blockTime: at(when),
    },
  ])
}

const snapshot = (gameId: string, when: string, modelProb: number | null) =>
  insertSnapshot(env.h.db, {
    gameId,
    ts: at(when),
    homeScore: 50,
    awayScore: 45,
    period: 3,
    clockSecs: 300,
    modelProb,
  })

describe('GET /api/v1/me/{wallet}', () => {
  it('answers 404 problem+json while FLAG_ME is off, before any input check', async () => {
    for (const path of [`/me/${wallet}`, '/me/not-a-key', `/me/${wallet}?teams=bad`]) {
      const res = await get(path)
      expect(res.status, path).toBe(404)
      expect(res.headers.get('content-type')).toBe('application/problem+json')
      expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' })
    }
  })

  it('refuses a malformed wallet or teams list with 400', async () => {
    await flagOn()
    const teams31 = Array.from(
      { length: 31 },
      (_, i) =>
        `T${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`,
    )
    for (const path of [
      '/me/not-a-key',
      `/me/${wallet}?teams=mem`,
      `/me/${wallet}?teams=MEM,LAC2`,
      `/me/${wallet}?teams=ABCDEF`,
      `/me/${wallet}?teams=A`,
      `/me/${wallet}?teams=`,
      `/me/${wallet}?teams=${teams31.join(',')}`,
      `/me/${wallet}?other=1`,
    ]) {
      const res = await get(path)
      expect(res.status, path).toBe(400)
      expect(await res.json()).toMatchObject({ code: 'INVALID_INPUT' })
    }
    expect((await get(`/me/${wallet}?teams=${teams31.slice(0, 30).join(',')}`)).status).toBe(200)
  })

  it('gives an empty wallet an empty night, never cached', async () => {
    await flagOn()
    const res = await get(`/me/${wallet}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(MeResponseSchema.parse(await res.json())).toEqual({
      wallet,
      night: '2026-11-28',
      now: NOW,
      nights: 0,
      games: [],
      vsModel: { points: null, settled: 0, pending: 0, practicePoints: null },
      earlierClaimable: 0,
      nextGames: [],
    })
  })

  it('shows tonight’s position with its team, average price, if-wins lines and open call', async () => {
    await flagOn()
    const g = await addGame('nba-1')
    await play(g, 'live', 50, 45)
    const m = await addMarket(g)
    await snapshot(g, '2026-11-29T01:00:00Z', 0.62)
    await swap(m, '2026-11-29T01:05:00Z', { usdc: -20n * U, yes: 38_720_000n })
    await insertPricePoint(env.h.db, { market: m, ts: at('2026-11-29T01:06:00Z'), price: 0.64 })
    const body = await me()
    expect(body.games).toHaveLength(1)
    const [entry] = body.games
    expect(entry?.practice).toBe(false)
    expect(entry?.game).toMatchObject({ id: g, home: 'MEM', away: 'LAC', status: 'live' })
    expect(entry?.positions).toHaveLength(1)
    expect(entry?.positions[0]).toMatchObject({
      market: m,
      side: 'home',
      team: 'MEM',
      shares: '38.72',
      costUsdc: '20',
      price: 0.64,
      status: 'open',
      challengeEndsAt: null,
      call: { model: 0.62, result: null, points: null },
    })
    expect(entry?.positions[0]?.avgPrice).toBeCloseTo(20 / 38.72)
    expect(entry?.ifHomeWins).toEqual({ payoutUsdc: '38.72', netUsdc: '18.72' })
    expect(entry?.ifAwayWins).toEqual({ payoutUsdc: '0', netUsdc: '-20' })
    expect(body.vsModel).toEqual({ points: null, settled: 0, pending: 1, practicePoints: null })
  })

  it('rolls the night over at 06:00 ET', async () => {
    await flagOn()
    const g = await addGame('nba-1')
    const m = await addMarket(g)
    await swap(m, '2026-11-29T00:00:00Z', { usdc: -10n * U, yes: 18n * U })
    env.deps.now = () => secs('2026-11-29T10:59:59Z')
    const late = await me()
    expect(late.night).toBe('2026-11-28')
    expect(late.games.map((e) => e.game.id)).toEqual([g])
    env.deps.now = () => secs('2026-11-29T11:00:00Z')
    const morning = await me()
    expect(morning.night).toBe('2026-11-29')
    expect(morning.games).toEqual([])
  })

  it('maps each status, with the challenge end from the on-chain window', async () => {
    await flagOn()
    env.chain.set(program.config, configAccount(900))
    const proposedAt = at('2026-11-29T01:50:00Z')
    const cases: Array<[string, Partial<Parameters<typeof upsertMarket>[1]>, string, string]> = [
      ['nba-1', { status: 'proposed', proposedAt }, 'final', 'proposed'],
      ['nba-2', { status: 'challenged', proposedAt }, 'final', 'challenged'],
      ['nba-3', { status: 'halted' }, 'live', 'closed'],
      ['nba-4', { status: 'finalized', outcome: 'yes' }, 'final', 'final'],
      ['nba-5', { status: 'open' }, 'final', 'closed'],
      ['nba-6', { status: 'open' }, 'live', 'open'],
    ]
    const markets = new Map<string, string>()
    for (const [id, market, game] of cases) {
      await addGame(id)
      await play(id, game, 100, 90)
      const m = await addMarket(id, market)
      markets.set(id, m)
      await swap(m, '2026-11-29T00:10:00Z', { usdc: -5n * U, yes: 9n * U })
    }
    const body = await me()
    const byGame = new Map(body.games.map((e) => [e.game.id, e.positions[0]]))
    for (const [id, , , status] of cases) expect(byGame.get(id)?.status, id).toBe(status)
    expect(byGame.get('nba-1')?.challengeEndsAt).toBe(proposedAt.getTime() / 1000 + 900)
    expect(byGame.get('nba-2')?.challengeEndsAt).toBeNull()
    // Settled: no if-wins lines.
    const settled = body.games.find((e) => e.game.id === 'nba-4')
    expect(settled?.ifHomeWins).toBeNull()
    expect(settled?.ifAwayWins).toBeNull()

    // A Config read that fails gives null, never 900; the next read is not held back by it.
    env.chain.accountsFail = true
    const other = createApp(env.deps)
    const failed = await me('', other)
    expect(
      failed.games.find((e) => e.game.id === 'nba-1')?.positions[0]?.challengeEndsAt,
    ).toBeNull()
    env.chain.accountsFail = false
    const again = await me('', other)
    expect(again.games.find((e) => e.game.id === 'nba-1')?.positions[0]?.challengeEndsAt).toBe(
      proposedAt.getTime() / 1000 + 900,
    )
  })

  it('scores tonight’s calls: +38 and -62 summed, pending while open, postponed never scored', async () => {
    await flagOn()
    // A: MEM backed at a 62% model, MEM won.
    const a = await addGame('nba-1')
    await play(a, 'final', 110, 100)
    const ma = await addMarket(a, { status: 'finalized', outcome: 'yes' })
    await snapshot(a, '2026-11-29T01:00:00Z', 0.62)
    await snapshot(a, '2026-11-29T01:30:00Z', 0.9)
    await swap(ma, '2026-11-29T01:05:00Z', { usdc: -10n * U, yes: 16n * U })
    // B: BOS backed before tip-off at p0 62%, BOS lost.
    const b = await addGame('nba-2', { home: 'BOS', away: 'NYK', p0: 0.62 })
    await play(b, 'final', 90, 100)
    const mb = await addMarket(b, { status: 'finalized', outcome: 'no' })
    await swap(mb, '2026-11-29T00:00:00Z', { usdc: -10n * U, yes: 16n * U })
    // C: still open, a call on the away side.
    const c = await addGame('nba-3', { home: 'DEN', away: 'PHX', p0: 0.7 })
    const mc = await addMarket(c)
    await swap(mc, '2026-11-29T00:00:00Z', { usdc: -10n * U, no: 30n * U })
    // D: postponed, resolved NO: never scored.
    const d = await addGame('nba-4', { home: 'MIA', away: 'CHI', status: 'postponed', p0: 0.5 })
    const md = await addMarket(d, { status: 'finalized', outcome: 'no' })
    await swap(md, '2026-11-29T00:00:00Z', { usdc: -10n * U, yes: 20n * U })

    const body = await me()
    const call = (id: string) => body.games.find((e) => e.game.id === id)?.positions[0]?.call
    expect(call(a)).toEqual({ model: 0.62, result: 'won', points: 38 })
    expect(call(b)).toEqual({ model: 0.62, result: 'lost', points: -62 })
    expect(call(c)).toMatchObject({ result: null, points: null })
    expect(call(c)?.model).toBeCloseTo(0.3)
    expect(call(d)).toEqual({ model: 0.5, result: 'lost', points: null })
    expect(body.vsModel).toEqual({ points: -24, settled: 2, pending: 1, practicePoints: null })
    // A won: its claim is tonight's, not an earlier one.
    expect(body.games.find((e) => e.game.id === a)?.positions[0]?.claimable).toBe(true)
    expect(body.earlierClaimable).toBe(0)
  })

  it('does not change a call when shares are sold', async () => {
    await flagOn()
    const g = await addGame('nba-1')
    const m = await addMarket(g)
    await snapshot(g, '2026-11-29T01:00:00Z', 0.62)
    await snapshot(g, '2026-11-29T01:20:00Z', 0.2)
    await swap(m, '2026-11-29T01:05:00Z', { usdc: -10n * U, yes: 16n * U })
    await swap(m, '2026-11-29T01:25:00Z', { usdc: 3n * U, yes: -8n * U })
    const body = await me()
    expect(body.games[0]?.positions[0]?.call?.model).toBe(0.62)
  })

  it('counts the nights: distinct tip-off dates from 11-27, never Practice or a kind 1 market', async () => {
    await flagOn()
    // ET 11-25: before the counted window.
    const early = await addGame('nba-1', { scheduledTipoff: at('2026-11-26T00:30:00Z') })
    await swap(await addMarket(early), '2026-11-26T01:00:00Z', { usdc: -1n * U, yes: 2n * U })
    // ET 11-27, two games: one night.
    for (const id of ['nba-2', 'nba-3']) {
      const g = await addGame(id, { scheduledTipoff: at('2026-11-28T00:30:00Z') })
      await swap(await addMarket(g), '2026-11-28T01:00:00Z', { usdc: -1n * U, yes: 2n * U })
    }
    // ET 11-28, 10:00 PM ET tip-off, a swap at 04:30 UTC on 11-29: still the 11-28 night.
    const late = await addGame('nba-4', { scheduledTipoff: at('2026-11-29T03:00:00Z') })
    await swap(await addMarket(late), '2026-11-29T04:30:00Z', { usdc: -1n * U, yes: 2n * U })
    // ET 11-29: a second-half market (kind 1) only.
    const half = await addGame('nba-5', { scheduledTipoff: at('2026-11-30T00:30:00Z') })
    await swap(await addMarket(half, { kind: 1 }), '2026-11-30T01:00:00Z', {
      usdc: -1n * U,
      yes: 2n * U,
    })
    // ET 11-30: Practice.
    const practice = await addGame('prac-1', {
      league: 'PRACTICE',
      scheduledTipoff: at('2026-12-01T00:30:00Z'),
    })
    await swap(await addMarket(practice), '2026-12-01T01:00:00Z', { usdc: -1n * U, yes: 2n * U })

    expect((await me()).nights).toBe(2)
    // The header's chip reads the same count from /positions.
    const res = await get(`/positions/${wallet}`)
    expect(PositionsResponseSchema.parse(await res.json()).nights).toBe(2)
  })

  it('counts a claim from an earlier night apart from tonight’s games', async () => {
    await flagOn()
    const early = await addGame('nba-1', { scheduledTipoff: at('2026-11-28T00:30:00Z') })
    await play(early, 'final', 100, 90)
    const m = await addMarket(early, { status: 'finalized', outcome: 'yes' })
    await swap(m, '2026-11-28T01:00:00Z', { usdc: -1n * U, yes: 2n * U })
    const body = await me()
    expect(body.games).toEqual([])
    expect(body.earlierClaimable).toBe(1)
  })

  it('groups Practice games apart, scored apart, while they matter', async () => {
    await flagOn()
    const recent = at('2026-11-29T01:00:00Z')
    // Won 1 h ago at a 40% model: shown, +60 Practice points.
    const p1 = await addGame('prac-1', {
      league: 'PRACTICE',
      home: 'CLE',
      away: 'CHA',
      scheduledTipoff: at('2026-11-20T00:30:00Z'),
      p0: 0.4,
    })
    await play(p1, 'final', 100, 90)
    const m1 = await addMarket(p1, { status: 'finalized', outcome: 'yes', finalizedAt: recent })
    await swap(m1, '2026-11-20T00:00:00Z', { usdc: -1n * U, yes: 2n * U })
    // Lost 13 h ago: nothing left to see.
    const p2 = await addGame('prac-2', { league: 'PRACTICE', scheduledTipoff: at(TIP) })
    await play(p2, 'final', 90, 100)
    const m2 = await addMarket(p2, {
      status: 'finalized',
      outcome: 'no',
      finalizedAt: at('2026-11-28T13:00:00Z'),
    })
    await swap(m2, '2026-11-29T00:00:00Z', { usdc: -1n * U, yes: 2n * U })
    // Still open on another date: shown.
    const p3 = await addGame('prac-3', {
      league: 'PRACTICE',
      scheduledTipoff: at('2026-11-21T00:30:00Z'),
    })
    await swap(await addMarket(p3), '2026-11-21T00:00:00Z', { usdc: -1n * U, yes: 2n * U })
    // And one NBA game tonight, which comes first.
    const g = await addGame('nba-1')
    await swap(await addMarket(g), '2026-11-29T00:00:00Z', { usdc: -1n * U, yes: 2n * U })

    const body = await me()
    expect(body.games.map((e) => [e.game.id, e.practice])).toEqual([
      ['nba-1', false],
      ['prac-1', true],
      ['prac-3', true],
    ])
    expect(body.vsModel).toEqual({ points: null, settled: 0, pending: 1, practicePoints: 60 })
    expect(body.nights).toBe(1)
  })

  it('lists the next game of each followed or held team: NBA, scheduled, 8 days, at most 5', async () => {
    await flagOn()
    // Held tonight: MEM and LAC. Tonight's own game is shown, so it is not a next game.
    const tonight = await addGame('nba-1')
    await swap(await addMarket(tonight), '2026-11-29T00:00:00Z', { usdc: -1n * U, yes: 2n * U })
    const day = (d: number, hour = 0) =>
      at(
        new Date(
          Date.parse('2026-11-30T00:30:00Z') + d * 86_400_000 + hour * 3_600_000,
        ).toISOString(),
      )
    await addGame('nba-10', { home: 'MEM', away: 'TOR', scheduledTipoff: day(0) })
    await addGame('nba-11', { home: 'MEM', away: 'UTA', scheduledTipoff: day(2) })
    await addGame('nba-12', { home: 'LAC', away: 'SAC', scheduledTipoff: day(1) })
    await addGame('nba-13', { home: 'DEN', away: 'BOS', scheduledTipoff: day(3) })
    await addGame('nba-14', { home: 'PHX', away: 'GSW', scheduledTipoff: day(4) })
    // MIA: a live game is not a next game; its scheduled one is.
    await addGame('nba-15', { home: 'MIA', away: 'ORL', scheduledTipoff: at(TIP) })
    await play('nba-15', 'live', 10, 8)
    await addGame('nba-16', { home: 'MIA', away: 'ATL', scheduledTipoff: day(5) })
    // CHI: Practice and 9 days out never count.
    await addGame('prac-1', { league: 'PRACTICE', home: 'CHI', scheduledTipoff: day(0) })
    await addGame('nba-17', { home: 'CHI', away: 'IND', scheduledTipoff: day(8, 1) })

    const all = await me('?teams=TOR,DEN,PHX,MIA,CHI')
    // MEM nba-10 (also TOR's), LAC nba-12, DEN nba-13 (also BOS), PHX nba-14, MIA nba-16: 5.
    expect(all.nextGames.map((g) => g.id)).toEqual([
      'nba-10',
      'nba-12',
      'nba-13',
      'nba-14',
      'nba-16',
    ])
    const held = await me()
    expect(held.nextGames.map((g) => g.id)).toEqual(['nba-10', 'nba-12'])
    // At most 5.
    await addGame('nba-18', { home: 'NOP', away: 'DAL', scheduledTipoff: day(0, 1) })
    const capped = await me('?teams=TOR,DEN,PHX,MIA,NOP')
    expect(capped.nextGames.map((g) => g.id)).toEqual([
      'nba-10',
      'nba-18',
      'nba-12',
      'nba-13',
      'nba-14',
    ])
  })
})

describe('GET /api/v1/positions/{wallet} and the nights', () => {
  it('carries nights only while FLAG_ME is on', async () => {
    const g = await addGame('nba-1')
    await swap(await addMarket(g), '2026-11-29T00:00:00Z', { usdc: -1n * U, yes: 2n * U })
    const off = PositionsResponseSchema.parse(await (await get(`/positions/${wallet}`)).json())
    expect(off.nights).toBeUndefined()
    expect(off.positions).toHaveLength(1)
    await flagOn()
    const on = PositionsResponseSchema.parse(await (await get(`/positions/${wallet}`)).json())
    expect(on.nights).toBe(1)
    expect(on.positions).toEqual(off.positions)
  })
})
