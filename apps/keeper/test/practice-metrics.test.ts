// R8: a Practice market is never counted. The create instruction a Practice round sends is read
// back as the program stores it (a GameMarket account starts with the create's own arguments),
// decoded by the frozen counting script (scripts/count-fans.mjs, docs/metrics.md), and counted
// with a fan's swap on it: league PRACTICE, kind 0, ignored, no fan wallet.
import { type DbHandle, setFlag } from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import { HORAGON_ACCOUNT_DISCRIMINATORS } from '@horagon/sdk'
import type { ReplayGame } from '@horagon/sdk/replay'
import { Keypair } from '@solana/web3.js'
import pino from 'pino'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { countFans, decodeGameMarket, type GameMarketRecord } from '../../../scripts/count-fans.mjs'
import { loadReplayDir } from '../src/feeds/replay'
import { DEFAULT_SEEDS } from '../src/planner'
import { PracticeArena, practiceKeeper } from '../src/practice/round'
import { PRACTICE_FIXTURES_DIR, PracticeFeed } from '../src/practice/runs'
import { PracticeChain, program } from './practice-chain'

const silent = pino({ level: 'silent' })
/** 12:00 UTC on 2026-12-06, a night inside the counting window. */
const SLOT = Date.parse('2026-12-06T12:00:00Z') / 1000

let fixtures: ReplayGame[]
let h: DbHandle
let chain: PracticeChain
let now: number

beforeAll(async () => {
  fixtures = await loadReplayDir(PRACTICE_FIXTURES_DIR)
})
beforeEach(async () => {
  h = await createTestDb()
  now = SLOT
  chain = new PracticeChain(h.db, now, 1_800)
  await setFlag(h.db, 'FLAG_PRACTICE', true, 'test')
})
afterEach(async () => {
  await h.close()
})

/** create_game_market's arguments, as the program copies them into the GameMarket account. */
function storedAccount(data: Buffer, market: Buffer): Buffer {
  const args = data.subarray(8)
  const idLen = args.readUInt32LE(8 + 1 + 8)
  // market_id u64, kind u8, league [u8; 8], external id (u32 + bytes), home, away, tip, end_ts.
  const fixed = 8 + 1 + 8 + 4 + idLen + 4 + 4 + 8 + 8
  return Buffer.concat([
    Buffer.from(HORAGON_ACCOUNT_DISCRIMINATORS.GameMarket),
    market,
    args.subarray(0, fixed),
    Buffer.alloc(256),
  ])
}

describe('a Practice market and the frozen counting rules', () => {
  it('decodes with league PRACTICE, kind 0, and counts nothing for a swap on it', async () => {
    const feed = new PracticeFeed({
      fixtures,
      now: () => new Date(now * 1000),
      sourceBase: 'https://example.test/replay',
    })
    const keeper = practiceKeeper({
      db: h.db,
      sender: chain.sender,
      program,
      attestor: chain.attestor,
      feed,
      alerts: { send: async () => true },
      log: silent,
      now: () => now,
      sigma: 13,
      priority: { normal: 10_000, halt: 200_000 },
      evidenceUri: (id) => `https://horagon.example/api/v1/evidence/${id}/winner`,
      feedEverySecs: 0,
    })
    const arena = new PracticeArena({
      db: h.db,
      keeper,
      feed,
      alerts: { send: async () => true },
      log: silent,
      now: () => now,
      fixtures,
      ratings: { asOf: '2026-11-17', sigma: 13, teams: {} },
      nbaSeeds: DEFAULT_SEEDS,
      solFloorLamports: 1_000_000_000n,
      balances: {
        attestorLamports: async () => 2_000_000_000n,
        seedFunds: async () => 5_000_000_000n,
      },
    })
    expect((await arena.round()).started).toBe('practice-401910014p0')
    now += 5
    await arena.round()
    const create = chain.specs.find((s) => s.label.startsWith('create '))
    const ix = create?.instructions.at(-1)
    if (!ix) throw new Error('no create sent')
    const gameMarket = ix.keys[3]?.pubkey
    const market = ix.keys[4]?.pubkey
    if (!gameMarket || !market) throw new Error('create without its accounts')

    const decoded = decodeGameMarket(storedAccount(ix.data, market.toBuffer()))
    expect(decoded).toEqual({
      market: market.toBase58(),
      kind: 0,
      league: 'PRACTICE',
      gameId: '401910014p0',
      scheduledTipoff: SLOT + 600,
    })

    const record: GameMarketRecord = { address: gameMarket.toBase58(), ...decoded }
    const fan = Keypair.generate().publicKey.toBase58()
    const report = countFans({
      markets: [record],
      swaps: [
        {
          signature: 's1',
          wallet: fan,
          market: market.toBase58(),
          blockTime: SLOT + 900,
          botMemo: false,
        },
        {
          signature: 's2',
          wallet: fan,
          market: market.toBase58(),
          blockTime: SLOT + 960,
          botMemo: false,
        },
      ],
      wallets: { version: 1, teamWallets: [], excludedMarkets: [] },
    })
    expect(report.markets).toEqual({ counted: 0, excluded: 0, ignored: 1 })
    expect(report.swaps).toEqual({ counted: 0, nightTouches: 0 })
    expect(report.classes.human.wallets).toBe(0)
    expect(report.threeNightFans).toBe(0)

    // The same market under league NBA would count: the league alone keeps Practice out.
    const nba = countFans({
      markets: [{ ...record, league: 'NBA' }],
      swaps: [
        {
          signature: 's1',
          wallet: fan,
          market: market.toBase58(),
          blockTime: SLOT + 900,
          botMemo: false,
        },
      ],
      wallets: { version: 1, teamWallets: [], excludedMarkets: [] },
    })
    expect(nba.markets.counted).toBe(1)
    expect(nba.classes.human.wallets).toBe(1)
  })
})
