// First-screen story data (spec W1): GET /api/v1/nights/{date}, each final NBA game of one ET
// date with its winner market, told from the winner's side. Real ET 11-25 data (the public API's
// answers, tests/fixtures/nights/2026-11-25.json) and a synthetic night whose price moved.
import { readFileSync } from 'node:fs'
import {
  type Db,
  insertTrades,
  schema,
  updateGameLive,
  upsertMarket,
  upsertScheduledGames,
} from '@horagon/db'
import {
  type Game,
  type Night,
  NightSchema,
  REFERENCE_AGENT_WALLET,
  type Resolution,
} from '@horagon/sdk'
import { HoragonClient } from '@horagon/sdk/client'
import { Keypair } from '@solana/web3.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { downsample, NIGHT_POINTS, nightGame } from '../src/nights'
import { makeEnv, type TestEnv } from './helpers'

interface RawNight {
  games: Game[]
  details: Record<string, { resolutions: Resolution[] }>
  history: Record<
    string,
    {
      snapshots: Array<[number, number, number, number, number | null, number | null]>
      prices: Record<string, Array<[number, number]>>
    }
  >
}

const RAW = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/nights/2026-11-25.json', import.meta.url), 'utf8'),
) as RawNight

const date = (secs: number) => new Date(secs * 1000)

/** Inserts in chunks: PGlite takes one statement of a few thousand rows at a time. */
async function chunked<T>(rows: T[], insert: (part: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += 1_000) await insert(rows.slice(i, i + 1_000))
}

/** The fixture's games, markets, snapshots and price points, as the keeper wrote them. */
async function seedRaw(db: Db, raw: RawNight) {
  for (const g of raw.games) {
    const m = g.markets.find((x) => x.kind === 'winner')
    const r = raw.details[g.id]?.resolutions.find((x) => x.kind === 'winner')
    if (!m || !r) throw new Error(`fixture ${g.id} has no winner market`)
    await upsertScheduledGames(db, [
      {
        id: g.id,
        league: g.league,
        externalId: g.id.replace(/^\D+-/, ''),
        gameDate: '2026-11-25',
        home: g.home,
        away: g.away,
        scheduledTipoff: new Date(g.scheduledTipoff),
        status: 'scheduled',
        p0: m.initialPriceBps / 10_000,
      },
    ])
    await updateGameLive(db, g.id, {
      status: g.status,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      period: g.period,
      clockSecs: g.clockSecs,
      periods: [],
      modelProb: g.modelProb,
      feedUpdatedAt: new Date(g.updatedAt),
    })
    await upsertMarket(db, {
      pubkey: m.pubkey,
      gameId: g.id,
      kind: 0,
      marketId: `fixture-${g.id}`,
      gameMarketPda: r.gameMarket,
      yesMint: `yes-${m.pubkey}`,
      noMint: `no-${m.pubkey}`,
      initialPriceBps: m.initialPriceBps,
      endTs: date(m.endTs),
      seedAmount: BigInt(m.seedUsdc) * 1_000_000n,
      status: m.status,
      outcome: m.outcome,
      evidenceHash: r.evidenceHash,
      createSig: r.createSig,
      proposeSig: r.proposeSig,
      finalizeSig: r.finalizeSig,
      recycleSig: r.recycleSig,
      proposedAt: r.proposedAt === null ? null : date(r.proposedAt),
    })
    const h = raw.history[g.id]
    if (!h) throw new Error(`fixture ${g.id} has no history`)
    await chunked(h.snapshots, (part) =>
      db.insert(schema.gameSnapshots).values(
        part.map(([ts, homeScore, awayScore, period, clockSecs, modelProb]) => ({
          gameId: g.id,
          ts: date(ts),
          homeScore,
          awayScore,
          period,
          clockSecs,
          modelProb,
        })),
      ),
    )
    for (const [market, points] of Object.entries(h.prices)) {
      await chunked(points, (part) =>
        db
          .insert(schema.pricePoints)
          .values(part.map(([ts, price]) => ({ market, ts: date(ts), price }))),
      )
    }
  }
}

const clientOf = (app: ReturnType<typeof createApp>) =>
  new HoragonClient({
    baseUrl: 'http://horagon.test/api/v1',
    retries: 0,
    fetch: async (input, init) =>
      app.fetch(input instanceof Request ? input : new Request(input, init)),
  })

describe('GET /nights/{date} on real ET 11-25 data', () => {
  let env: TestEnv
  let app: ReturnType<typeof createApp>
  let night: Night
  let res: Response

  beforeAll(async () => {
    env = await makeEnv()
    app = createApp(env.deps)
    await seedRaw(env.h.db, RAW)
    // A Practice replay tipped off the same ET night: never part of the NBA night.
    await upsertScheduledGames(env.h.db, [
      {
        id: 'practice-401909320p1',
        league: 'PRACTICE',
        externalId: '401909320p1',
        gameDate: '2026-11-25',
        home: 'OKC',
        away: 'MIN',
        scheduledTipoff: new Date('2026-11-26T02:00:00Z'),
        status: 'scheduled',
        p0: 0.7,
      },
    ])
    await updateGameLive(env.h.db, 'practice-401909320p1', {
      status: 'final',
      homeScore: 90,
      awayScore: 120,
      period: 4,
      clockSecs: null,
      periods: [],
      modelProb: 0,
      feedUpdatedAt: new Date('2026-11-26T03:00:00Z'),
    })
    await upsertMarket(env.h.db, {
      pubkey: 'PracticeMkt1',
      gameId: 'practice-401909320p1',
      kind: 0,
      marketId: 'practice-1',
      gameMarketPda: 'gm-practice',
      yesMint: 'yes-practice',
      noMint: 'no-practice',
      initialPriceBps: 9000,
      endTs: new Date('2026-11-26T05:00:00Z'),
      seedAmount: 1_000_000_000n,
      status: 'finalized',
      outcome: 'no',
    })
    res = await app.request('/api/v1/nights/2026-11-25')
    night = NightSchema.parse(await res.clone().json())
  }, 120_000)
  afterAll(async () => {
    await env.h.close()
  })

  it('answers 200, cached 10 min at the edge, with the 9 final NBA games and no Practice', () => {
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('s-maxage=600, stale-while-revalidate=600')
    expect(night.date).toBe('2026-11-25')
    expect(night.games.map((g) => g.id)).toEqual(RAW.games.map((g) => g.id))
    expect(night.games.some((g) => g.id.startsWith('practice-'))).toBe(false)
    expect(night.upsets).toBe(2)
    expect(night.games.filter((g) => g.upset).map((g) => g.winner)).toEqual(['CHI', 'MIN'])
  })

  it('tells MIN @ OKC from the winner side: from 28%, the model low 7% at Q3 5:41, down 63–74', () => {
    const g = night.games.find((x) => x.id === 'nba-401909320')
    expect(g).toMatchObject({
      home: 'OKC',
      away: 'MIN',
      homeScore: 106,
      awayScore: 113,
      winner: 'MIN',
      loser: 'OKC',
      period: 4,
      market: '54WUazC5Dcit8K8mjigTgNQfvEjeFxdUWU7QEDNPaD4G',
      openedBps: 2819,
      moved: false,
      upset: true,
      overtime: false,
      calls: { fans: 0, fanWallets: 0, agent: 0, others: 0 },
      resolution: {
        market: '54WUazC5Dcit8K8mjigTgNQfvEjeFxdUWU7QEDNPaD4G',
        status: 'recycled',
        challengeEndsAt: null,
      },
    })
    expect(g?.closed).toBeCloseTo(0.2819, 6)
    expect(g?.low).toEqual({
      ts: 1795659246,
      prob: expect.closeTo(0.0737, 4),
      period: 3,
      clockSecs: 341,
      winnerScore: 63,
      loserScore: 74,
      from: 'model',
    })
    expect(g?.periodStarts).toHaveLength(4)
  })

  it('keeps each line to 60 points with its low and high, the model cut at the final buzzer', () => {
    for (const g of night.games) {
      const snaps = RAW.history[g.id]?.snapshots ?? []
      const homeWon = g.winner === g.home
      const live = snaps.filter((s) => s[3] >= 1 && s[5] !== null)
      const finalAt = live.find((s) => s[4] === null)?.[0]
      const kept = live.filter((s) => finalAt === undefined || s[0] <= (finalAt as number))
      const probs = kept.map((s) => (homeWon ? (s[5] as number) : 1 - (s[5] as number)))
      expect(g.model.length).toBeLessThanOrEqual(NIGHT_POINTS)
      expect(g.model.length).toBe(Math.min(NIGHT_POINTS, kept.length))
      expect(g.model[0]?.[0]).toBe(kept[0]?.[0])
      // The line ends on the first final-state snapshot: the later score fixes are not drawn.
      expect(g.model.at(-1)?.[0]).toBe(finalAt)
      expect(Math.min(...g.model.map((p) => p[1]))).toBeCloseTo(Math.min(...probs), 9)
      expect(Math.max(...g.model.map((p) => p[1]))).toBeCloseTo(Math.max(...probs), 9)
      expect(g.low?.prob).toBeCloseTo(Math.min(...probs), 9)
      expect(g.price.length).toBeGreaterThan(0)
      expect(g.price.length).toBeLessThanOrEqual(NIGHT_POINTS)
      // Flat night: no swaps, so the price never moved from the opening.
      for (const [, p] of g.price) expect(p).toBeCloseTo(g.openedBps / 10_000, 6)
      expect(g.moved).toBe(false)
    }
  })

  it('serves the committed night JSON byte for byte, and the SDK client parses it', async () => {
    await expect(`${JSON.stringify(night, null, 2)}\n`).toMatchFileSnapshot(
      '../../../tests/fixtures/nights/2026-11-25.night.json',
    )
    expect(await clientOf(app).nights('2026-11-25')).toEqual(night)
  })

  it('answers an empty night for a date with no final game, and refuses a bad date', async () => {
    const empty = await app.request('/api/v1/nights/2026-11-26')
    expect(empty.status).toBe(200)
    expect(NightSchema.parse(await empty.json())).toEqual({
      date: '2026-11-26',
      upsets: 0,
      games: [],
    })
    const bad = await app.request('/api/v1/nights/2026-13-40')
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ code: 'INVALID_INPUT' })
  })
})

// A synthetic ET 11-27: NYK (home, opened 60%) beat MIA 110–100. The price dipped to 35% in Q2
// and closed at 81%; 14 calls, 12 by the reference agent and 2 by one fan.
const TIP = Date.parse('2026-11-28T00:00:00Z') / 1000
/** Fixed keys, so the committed moved night stays the same from run to run. */
const keyOf = (byte: number) => Keypair.fromSeed(new Uint8Array(32).fill(byte)).publicKey.toBase58()
const MOVED = keyOf(7)
const FAN = keyOf(8)

/** [secs after tip, period, clock, home, away, model (home)]: 3 snapshots a quarter, then Final. */
const SNAPS: Array<[number, number, number | null, number, number, number]> = [
  [0, 1, 720, 0, 0, 0.62],
  [600, 1, 360, 14, 12, 0.6],
  [1200, 1, 0, 26, 25, 0.58],
  [1500, 2, 720, 26, 25, 0.58],
  [2100, 2, 360, 38, 47, 0.33],
  [2700, 2, 0, 50, 55, 0.4],
  [3600, 3, 720, 50, 55, 0.4],
  [4200, 3, 360, 60, 70, 0.3],
  [4800, 3, 0, 75, 78, 0.45],
  [5100, 4, 720, 75, 78, 0.45],
  [5700, 4, 360, 95, 90, 0.72],
  [6300, 4, 0, 110, 100, 0.99],
  [6360, 4, null, 110, 100, 1],
  // A score fix hours later: never on the line.
  [20000, 4, null, 110, 100, 1],
]
/** [secs after tip, home price]: open 60 min before tip-off, then the swaps' prices. */
const PRICES: Array<[number, number]> = [
  [-3600, 0.6],
  [-1800, 0.61],
  [600, 0.58],
  [2100, 0.35],
  [4200, 0.42],
  [5700, 0.7],
  [6300, 0.8],
  [6340, 0.81],
]

async function seedMoved(db: Db) {
  const at = (s: number) => date(TIP + s)
  await upsertScheduledGames(db, [
    {
      id: 'nba-401909400',
      league: 'NBA',
      externalId: '401909400',
      gameDate: '2026-11-27',
      home: 'NYK',
      away: 'MIA',
      scheduledTipoff: at(0),
      status: 'scheduled',
      p0: 0.6,
    },
    // Not part of the night: still on, no market, and a market that is not the winner's.
    ...['nba-401909401', 'nba-401909402', 'nba-401909403'].map((id, i) => ({
      id,
      league: 'NBA',
      externalId: id.slice(4),
      gameDate: '2026-11-27',
      home: 'BOS',
      away: 'ATL',
      scheduledTipoff: at(1800 * (i + 1)),
      status: 'scheduled',
      p0: 0.5,
    })),
  ])
  const final = { status: 'final', period: 4, clockSecs: null, periods: [], modelProb: 1 }
  await updateGameLive(db, 'nba-401909400', {
    ...final,
    homeScore: 110,
    awayScore: 100,
    feedUpdatedAt: at(6360),
  })
  await updateGameLive(db, 'nba-401909401', {
    ...final,
    status: 'live',
    homeScore: 50,
    awayScore: 40,
    period: 2,
    clockSecs: 300,
    modelProb: 0.7,
    feedUpdatedAt: at(3000),
  })
  await updateGameLive(db, 'nba-401909402', {
    ...final,
    homeScore: 99,
    awayScore: 90,
    feedUpdatedAt: at(9000),
  })
  await updateGameLive(db, 'nba-401909403', {
    ...final,
    homeScore: 99,
    awayScore: 90,
    feedUpdatedAt: at(9000),
  })
  const base = {
    yesMint: 'yes',
    noMint: 'no',
    initialPriceBps: 6000,
    endTs: at(7800),
    seedAmount: 1_000_000_000n,
  }
  await upsertMarket(db, {
    ...base,
    pubkey: MOVED,
    gameId: 'nba-401909400',
    kind: 0,
    marketId: 'moved-0',
    gameMarketPda: 'gm-moved',
    status: 'proposed',
    outcome: 'yes',
    proposedAt: at(8000),
  })
  await upsertMarket(db, {
    ...base,
    pubkey: 'LiveMkt1',
    gameId: 'nba-401909401',
    kind: 0,
    marketId: 'live-0',
    gameMarketPda: 'gm-live',
    status: 'open',
  })
  await upsertMarket(db, {
    ...base,
    pubkey: 'HalfMkt1',
    gameId: 'nba-401909403',
    kind: 1,
    marketId: 'half-1',
    gameMarketPda: 'gm-half',
    status: 'finalized',
  })
  await db.insert(schema.gameSnapshots).values(
    SNAPS.map(([s, period, clockSecs, homeScore, awayScore, modelProb]) => ({
      gameId: 'nba-401909400',
      ts: at(s),
      period,
      clockSecs,
      homeScore,
      awayScore,
      modelProb,
    })),
  )
  await db
    .insert(schema.pricePoints)
    .values(PRICES.map(([s, price]) => ({ market: MOVED, ts: at(s), price })))
  const trade = (i: number, wallet: string) => ({
    sig: `sig${i}`,
    ixIndex: 0,
    market: MOVED,
    wallet,
    direction: 'usdcToYes',
    usdcAmount: 5_000_000n,
    usdcDelta: -5_000_000n,
    yesDelta: 8_000_000n,
    noDelta: 0n,
    fee: 0n,
    slot: BigInt(1000 + i),
    blockTime: at(-1800 + i * 600),
    botMemo: false,
  })
  await insertTrades(db, [
    ...Array.from({ length: 12 }, (_, i) => trade(i, REFERENCE_AGENT_WALLET)),
    trade(12, FAN),
    trade(13, FAN),
  ])
}

describe('GET /nights/{date} on a night whose price moved', () => {
  let env: TestEnv
  let night: Night

  beforeAll(async () => {
    env = await makeEnv()
    const app = createApp(env.deps)
    await seedMoved(env.h.db)
    night = await clientOf(app).nights('2026-11-27')
  }, 120_000)
  afterAll(async () => {
    await env.h.close()
  })

  it('leaves out a live game, a game with no winner market, and counts no upset', () => {
    expect(night.games.map((g) => g.id)).toEqual(['nba-401909400'])
    expect(night.upsets).toBe(0)
  })

  it('says it moved: 14 calls, 2 by one fan, 12 by the agent, closed 81%, the low from the price', () => {
    const g = night.games[0]
    expect(g).toMatchObject({
      winner: 'NYK',
      loser: 'MIA',
      openedBps: 6000,
      closed: 0.81,
      moved: true,
      upset: false,
      calls: { fans: 2, fanWallets: 1, agent: 12, others: 0 },
      // The challenge window is read on chain; the test chain has no Config, so it is unknown.
      resolution: { market: MOVED, status: 'proposed', challengeEndsAt: null },
      periodStarts: [TIP, TIP + 1500, TIP + 3600, TIP + 5100],
    })
    expect(g?.low).toEqual({
      ts: TIP + 2100,
      prob: 0.35,
      period: 2,
      clockSecs: 360,
      winnerScore: 38,
      loserScore: 47,
      from: 'price',
    })
    // The model line: from tip-off to the first Final snapshot, never the later score fix.
    expect(g?.model.map(([t]) => t - TIP)).toEqual(SNAPS.slice(0, 13).map(([s]) => s))
    expect(g?.model.at(-1)).toEqual([TIP + 6360, 1])
    // The price line: from the open, cut at the final buzzer.
    expect(g?.price).toEqual(PRICES.map(([s, p]) => [TIP + s, p]))
  })

  it('serves the committed moved night, the web story tests read it', async () => {
    await expect(`${JSON.stringify(night, null, 2)}
`).toMatchFileSnapshot('../../../tests/fixtures/nights/moved.night.json')
  })
})

describe('nightGame and downsample (pure)', () => {
  it('downsample keeps short lines whole, and long ones at 60 points with both ends, low and high', () => {
    const short: Array<[number, number]> = [
      [1, 0.5],
      [2, 0.4],
    ]
    expect(downsample(short)).toEqual(short)
    const long = Array.from({ length: 2000 }, (_, i): [number, number] => [
      i,
      0.5 + 0.4 * Math.sin(i / 50),
    ])
    long[777] = [777, 0.01]
    long[1333] = [1333, 0.99]
    const out = downsample(long, [1500])
    expect(out).toHaveLength(NIGHT_POINTS)
    expect(out[0]).toEqual(long[0])
    expect(out.at(-1)).toEqual(long.at(-1))
    expect(out).toContainEqual([777, 0.01])
    expect(out).toContainEqual([1333, 0.99])
    expect(out).toContainEqual(long[1500])
    expect(out.map(([t]) => t)).toEqual([...out.map(([t]) => t)].sort((a, b) => a - b))
  })

  it('times a proposed result from the window, and drops a tie or an unfinished game', () => {
    const tip = new Date('2026-11-28T00:00:00Z')
    const game = {
      id: 'nba-1',
      league: 'NBA',
      externalId: '1',
      gameDate: '2026-11-27',
      home: 'NYK',
      away: 'MIA',
      scheduledTipoff: tip,
      status: 'final',
      homeScore: 100,
      awayScore: 90,
      period: 4,
      clockSecs: null,
      periods: [],
      featured: false,
      p0: 0.6,
      modelProb: 1,
      feedUpdatedAt: null,
      updatedAt: tip,
      markets: [
        {
          pubkey: 'Mkt1',
          gameId: 'nba-1',
          kind: 0,
          marketId: '01',
          gameMarketPda: 'gm',
          yesMint: 'y',
          noMint: 'n',
          initialPriceBps: 6000,
          endTs: tip,
          seedAmount: 1n,
          status: 'proposed',
          outcome: 'yes',
          evidenceHash: null,
          challengeCount: 0,
          externalLp: false,
          createSig: null,
          haltSig: null,
          proposeSig: null,
          finalizeSig: null,
          recycleSig: null,
          proposedAt: new Date('2026-11-28T03:00:00Z'),
          finalizedAt: null,
          recycledAt: null,
          indexCursor: null,
          updatedAt: tip,
        },
      ],
    }
    const input = {
      game,
      snapshots: [],
      prices: [],
      latest: undefined,
      trades: [],
      memoWallets: new Set<string>(),
      windowSecs: 900,
    }
    const g = nightGame(input)
    expect(g?.resolution.challengeEndsAt).toBe(Date.parse('2026-11-28T03:15:00Z') / 1000)
    expect(g).toMatchObject({ low: null, model: [], price: [], closed: null, moved: false })
    expect(nightGame({ ...input, game: { ...game, awayScore: 100 } })).toBeNull()
    expect(nightGame({ ...input, game: { ...game, status: 'live' } })).toBeNull()
    expect(nightGame({ ...input, game: { ...game, markets: [] } })).toBeNull()
  })
})
