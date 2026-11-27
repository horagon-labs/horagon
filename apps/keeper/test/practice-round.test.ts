// R8: the Practice process's round. Each slot is checked against its guards; a run that starts
// plays on the fake chain from create to finalize: live, the horn halt, Final, the propose with
// `replay` evidence, the finalize and the recycle. FLAG_PRACTICE off stops new runs only.
import {
  type DbHandle,
  type GameWithMarkets,
  getEvidence,
  getGame,
  getMarketIdReservation,
  listOps,
  setFlag,
  upsertScheduledGames,
} from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import { marketIdFor } from '@horagon/sdk'
import type { ReplayGame } from '@horagon/sdk/replay'
import pino from 'pino'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Alerter } from '../src/alerts'
import type { Ratings } from '../src/elo'
import { loadReplayDir } from '../src/feeds/replay'
import { DEFAULT_SEEDS } from '../src/planner'
import {
  FUNDS_RECHECK_SECS,
  nextFreeSlot,
  PracticeArena,
  type PracticeArenaDeps,
  practiceKeeper,
  practiceSkip,
  type SkipInput,
} from '../src/practice/round'
import { PRACTICE_FIXTURES_DIR, PracticeFeed } from '../src/practice/runs'
import { LAMPORTS_PER_MARKET } from '../src/treasury'
import { account } from './chain-fixtures'
import { createdMarketId, PracticeChain, program, STATUS } from './practice-chain'

const silent = pino({ level: 'silent' })
const RATINGS: Ratings = { asOf: '2026-11-17', sigma: 13, teams: {} }
const BASE = 'https://example.test/repo/tests/fixtures/replay'
const PUBLIC = 'https://horagon.example'
/** 12:00 UTC on a day with no NBA game near (07:00 ET). */
const SLOT = Date.parse('2026-12-06T12:00:00Z') / 1000
const SOL = 1_000_000_000n

let fixtures: ReplayGame[]
let memCle: ReplayGame
beforeAll(async () => {
  fixtures = await loadReplayDir(PRACTICE_FIXTURES_DIR)
  const f = fixtures.find((x) => x.espnEventId === '401910007')
  if (!f) throw new Error('no MEM@CLE recording')
  // The recording's last live frame reads 0.1 s left, 30 recorded seconds before its Final: time
  // left, not the horn (a sub-second clock reads 1). Here that frame reads 0.0, the horn, and the
  // Final and what follows move 120 s later, so the horn frame holds 25 s and the round shows
  // the horn halt.
  const finalAt = Date.parse(
    f.frames.find((x) => x.source === 'espn' && x.status === 'final')?.t ?? '',
  )
  const lastLive = f.frames.filter((x) => x.source === 'espn' && x.status === 'live').at(-1)
  memCle = {
    ...f,
    frames: f.frames.map((x) =>
      Date.parse(x.t) >= finalAt
        ? { ...x, t: new Date(Date.parse(x.t) + 120_000).toISOString() }
        : x === lastLive
          ? { ...x, clock: '0.0' }
          : x,
    ),
  }
})

let h: DbHandle
let now: number
let chain: PracticeChain
let alerts: Array<[string, string]>
const alerter: Alerter = { send: async (k, t) => void alerts.push([k, t]) }
let lamports: bigint
let authority: bigint
let funds: bigint
let arena: PracticeArena
/** Market ids the Practice keeper draws, in order; empty means R9's own random draw. */
let draws: bigint[]

function arenaOf(over: Partial<PracticeArenaDeps> = {}): PracticeArena {
  const feed = new PracticeFeed({
    fixtures: [memCle],
    now: () => new Date(now * 1000),
    sourceBase: BASE,
  })
  const keeper = practiceKeeper({
    db: h.db,
    sender: chain.sender,
    program,
    attestor: chain.attestor,
    feed,
    alerts: alerter,
    log: silent,
    now: () => now,
    sigma: 13,
    priority: { normal: 10_000, halt: 200_000 },
    evidenceUri: (id) => `${PUBLIC}/api/v1/evidence/${id}/winner`,
    feedEverySecs: 0,
    ...(draws.length > 0 && { newMarketId: () => draws.shift() ?? 0n }),
  })
  return new PracticeArena({
    db: h.db,
    keeper,
    feed,
    alerts: alerter,
    log: silent,
    now: () => now,
    fixtures: [memCle],
    ratings: RATINGS,
    nbaSeeds: DEFAULT_SEEDS,
    solFloorLamports: SOL,
    balances: {
      attestorLamports: async () => lamports,
      authorityLamports: async () => authority,
      seedFunds: async () => funds,
    },
    ...over,
  })
}

beforeEach(async () => {
  h = await createTestDb()
  now = SLOT
  chain = new PracticeChain(h.db, now, 1_800)
  alerts = []
  lamports = 2n * SOL
  authority = SOL
  funds = 5_000_000_000n
  await setFlag(h.db, 'FLAG_PRACTICE', true, 'test')
  draws = []
  arena = arenaOf()
})
afterEach(async () => {
  await h.close()
})

/** Rounds every `step` seconds until `until`, with the chain clock following; what was sent. */
async function roundsTo(until: number, step = 5): Promise<string[]> {
  const sent: string[] = []
  const before = chain.sends.length
  while (now < until) {
    now = Math.min(until, now + step)
    chain.clock = now
    await arena.round()
  }
  sent.push(...chain.sends.slice(before))
  return sent
}

const ID = 'practice-401910007p0'
const TIP = SLOT + 600
/** MEM@CLE went Final 9,173.8 recorded seconds after its tip-off, 9,293.8 here: 1,549 s at 6x. */
const FINAL = TIP + 1_549

describe('a Practice round', () => {
  it('starts a run at its slot and plays it to the finalize on its own', async () => {
    const first = await arena.round()
    expect(first).toMatchObject({ started: ID, skipped: null })
    expect(await getGame(h.db, ID)).toMatchObject({
      league: 'PRACTICE',
      home: 'CLE',
      away: 'MEM',
      status: 'scheduled',
    })
    expect((await getGame(h.db, ID))?.scheduledTipoff.getTime()).toBe(TIP * 1000)
    // The next round opens the market at once: 300 mUSDC, end_ts = S' + 1,800.
    expect(await roundsTo(SLOT + 5)).toEqual([`create ${ID}`])
    const created = await getGame(h.db, ID)
    expect(created?.markets[0]).toMatchObject({ status: 'open', seedAmount: 300_000_000n })
    expect(created?.markets[0]?.endTs.getTime()).toBe((TIP + 1_800) * 1000)

    // The replayed game: live, then the horn frame held 10 s halts it before the Final.
    await roundsTo(TIP + 1_500, 60)
    expect((await getGame(h.db, ID))?.status).toBe('live')
    expect(await roundsTo(FINAL - 1)).toEqual([`halt ${ID} (horn)`])
    // The Final, then the draft, then the propose at end_ts with the recording as evidence.
    expect(await roundsTo(TIP + 1_800 - 5, 15)).toEqual([])
    expect((await getGame(h.db, ID))?.status).toBe('final')
    expect(await roundsTo(TIP + 1_800)).toEqual([`propose ${ID}`])
    const stored = await getEvidence(h.db, ID, 0)
    const ev = JSON.parse(stored?.json ?? '{}')
    expect(ev).toMatchObject({ league: 'PRACTICE', gameId: '401910007p0', outcome: 'no' })
    expect(ev.sources).toEqual([
      expect.objectContaining({ name: 'replay', url: `${BASE}/2026-11-18-MEM-at-CLE.json` }),
    ])
    expect(chain.market(ID)?.uri).toBe(`${PUBLIC}/api/v1/evidence/${ID}/winner`)
    // The 900 s window, then finalize and recycle.
    expect(await roundsTo(TIP + 1_800 + 900 + 10, 60)).toEqual([`finalize ${ID}`, `recycle ${ID}`])
    expect((await getGame(h.db, ID))?.markets[0]?.status).toBe('recycled')
    // The keeper's own pages stay off the guardian's chat: a Practice run needs nobody.
    expect(alerts).toEqual([])
    // The whole loop: 10 min to tip-off, 30 to end_ts, 15 of window, so 55 min from the slot.
    expect(now - SLOT).toBeLessThanOrEqual(55 * 60 + 10)
  })

  it('creates its market under a random id stored before the create is sent (R9)', async () => {
    await arena.round()
    let storedAtSend: string | null = null
    const send = chain.sender.send.bind(chain.sender)
    chain.sender.send = async (spec) => {
      if (spec.label === `create ${ID}`) {
        storedAtSend = await getMarketIdReservation(h.db, ID, 0)
        expect(createdMarketId(spec).toString()).toBe(storedAtSend)
      }
      return send(spec)
    }
    expect(await roundsTo(SLOT + 5)).toEqual([`create ${ID}`])
    expect(storedAtSend).not.toBeNull()
    const id = (await getGame(h.db, ID))?.markets[0]?.marketId
    expect(id).toBe(storedAtSend)
    expect(chain.market(ID)?.marketId.toString()).toBe(id)
    // Never an id anyone could compute from the game.
    for (let salt = 0; salt <= 9; salt++)
      expect(id).not.toBe((await marketIdFor('PRACTICE', '401910007p0', 0, salt)).toString())
  })

  it('replaces a squatted id with a fresh one and pages market-id-taken, as on an NBA night', async () => {
    const taken = 7_000_000_000_000_000_001n
    const fresh = 7_000_000_000_000_000_002n
    draws = [taken, fresh]
    arena = arenaOf()
    chain.accounts.set(program.addresses(taken).market.toBase58(), account(Buffer.alloc(16)))
    await arena.round()
    expect(await roundsTo(SLOT + 5)).toEqual([`create ${ID}`])
    expect(await getMarketIdReservation(h.db, ID, 0)).toBe(fresh.toString())
    expect((await getGame(h.db, ID))?.markets[0]?.marketId).toBe(fresh.toString())
    expect(alerts.map(([k]) => k)).toContain(`market-id-taken:${ID}`)
    expect((await listOps(h.db)).map((o) => o.action)).toContain('market-id-replaced')
  })

  it('names the run from the count of Practice games, cycling the recordings', async () => {
    await upsertScheduledGames(h.db, [
      {
        id: 'practice-401910007p0',
        league: 'PRACTICE',
        externalId: '401910007p0',
        gameDate: '2026-12-01',
        home: 'CLE',
        away: 'MEM',
        scheduledTipoff: new Date((SLOT - 5 * 86_400) * 1000),
        status: 'final',
        p0: 0.5,
      },
    ])
    expect((await arena.round()).started).toBe('practice-401910007p1')
  })

  it('stops starting runs with FLAG_PRACTICE off, while the run in flight still settles', async () => {
    await arena.round()
    await roundsTo(TIP + 600, 60)
    await setFlag(h.db, 'FLAG_PRACTICE', false, 'test')
    const sent = [
      ...(await roundsTo(TIP + 1_500, 60)),
      ...(await roundsTo(TIP + 1_800)),
      ...(await roundsTo(TIP + 1_800 + 900 + 10, 60)),
    ]
    expect(sent).toEqual([`halt ${ID} (horn)`, `propose ${ID}`, `finalize ${ID}`, `recycle ${ID}`])
    // The next slot is skipped, and no next tip-off is announced.
    now = SLOT + 7_200
    const next = await arena.round()
    expect(next).toMatchObject({ started: null, skipped: 'flag-off', nextAt: null })
  })

  it('skips a slot whose guard fails, says why, and pages the SOL floor', async () => {
    lamports = SOL - 1n
    expect(await arena.round()).toMatchObject({ started: null, skipped: 'sol-floor' })
    expect(alerts.map(([k]) => k)).toEqual(['practice-sol-floor'])
    // A slot is tried once: a later round of the same slot does not start it.
    lamports = 2n * SOL
    now += 60
    expect(await arena.round()).toMatchObject({ started: null })
    expect(await getGame(h.db, ID)).toBeNull()
  })

  it("skips while the Authority's SOL is short of 2 NBA nights of markets plus its own", async () => {
    // No NBA game ahead: 4 markets a night, 2 nights, and the run's own market.
    authority = 9n * LAMPORTS_PER_MARKET - 1n
    expect(await arena.round()).toMatchObject({ started: null, skipped: 'sol-authority' })
    expect(alerts.map(([k]) => k)).toEqual(['practice-sol-authority'])
    expect(alerts[0]?.[1]).toContain('horagon-ops fund-authority')
    expect(await getGame(h.db, ID)).toBeNull()
  })

  it('starts with the Authority holding exactly 2 NBA nights of markets plus its own', async () => {
    authority = 9n * LAMPORTS_PER_MARKET
    expect(await arena.round()).toMatchObject({ started: ID, skipped: null })
    expect(alerts).toEqual([])
  })

  it('pages a challenged Practice market, and starts no run while it waits', async () => {
    await arena.round()
    await roundsTo(TIP + 1_500, 60)
    await roundsTo(TIP + 1_800)
    chain.patch(ID, { status: STATUS.challenged, challenges: 1 })
    await roundsTo(TIP + 1_810)
    expect(alerts.map(([k]) => k)).toContain(`practice-challenged:${ID}`)
    // No next tip-off is promised while it waits: every slot would skip.
    expect((await arena.round()).nextAt).toBeNull()
    now = SLOT + 7_200
    expect(await arena.round()).toMatchObject({
      started: null,
      skipped: 'run-unsettled',
      nextAt: null,
    })
  })

  it('promises no next tip-off while a balance would skip it, and promises again after a top-up', async () => {
    expect(FUNDS_RECHECK_SECS).toBe(60)
    authority = 0n
    expect(await arena.round()).toMatchObject({ skipped: 'sol-authority', nextAt: null })
    // Between slots the balances are read again once a minute.
    authority = SOL
    now += 30
    expect((await arena.round()).nextAt).toBeNull()
    now += 30
    expect((await arena.round()).nextAt).toBe(SLOT + 7_200 + 600)
    // A balance that cannot be read changes nothing.
    arena = arenaOf({
      balances: {
        attestorLamports: async () => lamports,
        authorityLamports: async () => {
          throw new Error('rpc down')
        },
        seedFunds: async () => funds,
      },
    })
    now = SLOT + 1_800
    expect((await arena.round()).nextAt).toBe(SLOT + 7_200 + 600)
  })

  it('promises no next tip-off with too little mUSDC, or under the SOL floor', async () => {
    // Between slots: no slot is due, only the promise is checked.
    now = SLOT + 1_800
    funds = 0n
    expect(await arena.round()).toMatchObject({ skipped: null, nextAt: null })
    funds = 5_000_000_000n
    lamports = 0n
    arena = arenaOf()
    expect((await arena.round()).nextAt).toBeNull()
    lamports = 2n * SOL
    now += FUNDS_RECHECK_SECS
    expect((await arena.round()).nextAt).toBe(SLOT + 7_200 + 600)
  })

  it('announces the next tip-off: the next slot no NBA window blocks', async () => {
    const r = await arena.round()
    expect(r.nextAt).toBe(SLOT + 7_200 + 600)
    await upsertScheduledGames(h.db, [
      {
        id: 'nba-401920001',
        league: 'NBA',
        externalId: '401920001',
        gameDate: '2026-12-06',
        home: 'BOS',
        away: 'NYK',
        // 15:00 UTC: its window [14:00, 18:00] blocks the 14:00 and 16:00 slots.
        scheduledTipoff: new Date(Date.parse('2026-12-06T15:00:00Z')),
        status: 'scheduled',
        p0: 0.5,
      },
    ])
    expect((await arena.round()).nextAt).toBe(Date.parse('2026-12-06T18:10:00Z') / 1000)
  })
})

describe('practiceSkip, the guards', () => {
  const tip = (iso: string) => new Date(Date.parse(iso))
  const game = (over: Partial<GameWithMarkets>): GameWithMarkets =>
    ({
      id: 'nba-1',
      league: 'NBA',
      externalId: '1',
      gameDate: '2026-12-06',
      home: 'BOS',
      away: 'NYK',
      scheduledTipoff: tip('2026-12-06T20:00:00Z'),
      status: 'scheduled',
      homeScore: 0,
      awayScore: 0,
      period: 0,
      clockSecs: null,
      periods: [],
      featured: false,
      p0: 0.5,
      modelProb: null,
      feedUpdatedAt: null,
      updatedAt: new Date(0),
      markets: [],
      ...over,
    }) as GameWithMarkets
  const ok: SkipInput = {
    start: SLOT,
    now: SLOT,
    flagOn: true,
    nba: [],
    practice: [],
    attestorLamports: 2n * SOL,
    solFloorLamports: SOL,
    authorityLamports: SOL,
    authorityReserveLamports: 8n * LAMPORTS_PER_MARKET,
    seedFunds: 1_000_000_000n,
    nbaSeeds: [300_000_000n],
  }

  it('passes when every guard holds', () => {
    expect(practiceSkip(ok)).toBeNull()
  })

  it('skips with FLAG_PRACTICE off', () => {
    expect(practiceSkip({ ...ok, flagOn: false })).toBe('flag-off')
  })

  it('skips while another Practice run is not settled', () => {
    const market = (status: string) => [{ kind: 0, status }] as GameWithMarkets['markets']
    for (const status of ['open', 'halted', 'proposed', 'challenged']) {
      const practice = [game({ id: 'practice-x', league: 'PRACTICE', markets: market(status) })]
      expect(practiceSkip({ ...ok, practice }), status).toBe('run-unsettled')
    }
    for (const status of ['finalized', 'recycled']) {
      const practice = [game({ id: 'practice-x', league: 'PRACTICE', markets: market(status) })]
      expect(practiceSkip({ ...ok, practice }), status).toBeNull()
    }
    // A run whose market is still to be created counts; one whose create window passed does not.
    const pending = game({ league: 'PRACTICE', scheduledTipoff: new Date((SLOT + 300) * 1000) })
    expect(practiceSkip({ ...ok, practice: [pending] })).toBe('run-unsettled')
    const lapsed = game({ league: 'PRACTICE', scheduledTipoff: new Date((SLOT - 3_600) * 1000) })
    expect(practiceSkip({ ...ok, practice: [lapsed] })).toBeNull()
  })

  it('skips when an NBA window [tip - 60 min, close] overlaps [start, start + 90 min]', () => {
    // Tip-off 14:30: its window opens 13:30, exactly when the 12:00 run's 90 min end. No overlap.
    expect(
      practiceSkip({ ...ok, nba: [game({ scheduledTipoff: tip('2026-12-06T14:30:00Z') })] }),
    ).toBeNull()
    expect(
      practiceSkip({ ...ok, nba: [game({ scheduledTipoff: tip('2026-12-06T14:29:59Z') })] }),
    ).toBe('nba-window')
    // A game that tipped off at 09:30 is open until its close, 12:30 at the latest.
    expect(
      practiceSkip({
        ...ok,
        nba: [game({ scheduledTipoff: tip('2026-12-06T09:30:00Z'), status: 'live' })],
      }),
    ).toBe('nba-window')
    // Final at 11:45: its window ended at the Final.
    const done = game({
      scheduledTipoff: tip('2026-12-06T09:30:00Z'),
      status: 'final',
      feedUpdatedAt: tip('2026-12-06T11:45:00Z'),
    })
    expect(practiceSkip({ ...ok, nba: [done] })).toBeNull()
    // A postponed game has no window.
    const off = game({ scheduledTipoff: tip('2026-12-06T12:30:00Z'), status: 'postponed' })
    expect(practiceSkip({ ...ok, nba: [off] })).toBeNull()
  })

  it('skips under the SOL floor, or with too little mUSDC for the NBA seeds and its own', () => {
    expect(practiceSkip({ ...ok, attestorLamports: SOL - 1n })).toBe('sol-floor')
    expect(practiceSkip({ ...ok, attestorLamports: SOL })).toBeNull()
    expect(practiceSkip({ ...ok, seedFunds: 599_999_999n })).toBe('seed-short')
    expect(practiceSkip({ ...ok, seedFunds: 600_000_000n })).toBeNull()
    expect(practiceSkip({ ...ok, attestorLamports: null })).toBe('balance-unread')
    expect(practiceSkip({ ...ok, seedFunds: null })).toBe('balance-unread')
  })

  it('promises no slot while a run waits for a guardian or is overdue, none inside a run in flight', () => {
    const slots = [SLOT + 7_200, SLOT + 14_400]
    const run = (status: string, start: number) =>
      game({
        id: 'practice-x',
        league: 'PRACTICE',
        scheduledTipoff: new Date((start + 600) * 1000),
        markets: [{ kind: 0, status }] as GameWithMarkets['markets'],
      })
    const at = (now: number, practice: GameWithMarkets[]) =>
      nextFreeSlot({ now, slots, nba: [], practice })
    expect(at(SLOT, [])).toBe(SLOT + 7_200)
    // A run in flight since SLOT settles within its 90 min, before the next slot.
    expect(at(SLOT + 600, [run('open', SLOT)])).toBe(SLOT + 7_200)
    // A run whose 90 min run past a slot holds that slot back.
    expect(at(SLOT + 600, [run('open', SLOT + 1_801)])).toBe(SLOT + 14_400)
    // Challenged: it waits for a guardian, so no slot is promised.
    expect(at(SLOT + 3_000, [run('challenged', SLOT)])).toBeNull()
    // Still unsettled 90 min after its start: stuck, no slot is promised.
    expect(at(SLOT + 5_400, [run('halted', SLOT)])).toBeNull()
    expect(at(SLOT + 5_400, [run('recycled', SLOT)])).toBe(SLOT + 7_200)
    // An NBA window still blocks a slot: tip-off 13:00 holds [12:00, 16:00].
    const nba = [game({ scheduledTipoff: tip('2026-12-06T13:00:00Z') })]
    expect(nextFreeSlot({ now: SLOT, slots, nba, practice: [] })).toBe(SLOT + 14_400)
  })

  it("skips when the Authority's SOL would not cover the NBA reserve after the run's market", () => {
    const reserve = 8n * LAMPORTS_PER_MARKET
    const edge = reserve + LAMPORTS_PER_MARKET
    expect(practiceSkip({ ...ok, authorityLamports: edge - 1n })).toBe('sol-authority')
    expect(practiceSkip({ ...ok, authorityLamports: edge })).toBeNull()
    expect(practiceSkip({ ...ok, authorityLamports: null })).toBe('balance-unread')
    // The attestor's floor is checked first.
    expect(practiceSkip({ ...ok, attestorLamports: 0n, authorityLamports: 0n })).toBe('sol-floor')
  })
})
