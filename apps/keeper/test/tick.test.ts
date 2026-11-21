import {
  type DbHandle,
  type DraftRow,
  getDraft,
  getGame,
  listOps,
  listSnapshots,
  putEvidence,
  setDraftState,
  setFeatured,
  updateMarket,
  upsertMarket,
  upsertScheduledGames,
} from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import {
  DEVNET_MUSDC_MINT,
  decodeGameMarket,
  deriveGameMarket,
  HORAGON_ACCOUNT_DISCRIMINATORS,
  HoragonProgram,
  marketIdFor,
} from '@horagon/sdk'
import { asciiField, BorshWriter } from '@horagon/sdk/program'
import { type AccountInfo, type Connection, Keypair, PublicKey } from '@solana/web3.js'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProgramFailure, type SendSpec, type TxSender, UnresolvedAttempt } from '../src/executor'
import type { Feed, FeedGame } from '../src/feeds/types'
import { DEFAULT_SEEDS, DEFAULT_TIMINGS, type GameState } from '../src/planner'
import { Keeper, type KeeperDeps, minutesRemaining, stuckAlerts } from '../src/tick'

const S = 1_795_000_000
const END = S + DEFAULT_TIMINGS.endOffsetSecs
const program = new HoragonProgram({ collateralMint: DEVNET_MUSDC_MINT })
const attestor = Keypair.generate()
const STATUS = {
  open: 0,
  halted: 1,
  proposed: 2,
  challenged: 3,
  finalized: 4,
  recycled: 5,
} as const

function account(data: Buffer): AccountInfo<Buffer> {
  return { data, owner: program.programId, lamports: 1, executable: false, rentEpoch: 0 }
}

function configBytes(): Buffer {
  return new BorshWriter()
    .fixed(Uint8Array.from(HORAGON_ACCOUNT_DISCRIMINATORS.Config), 8)
    .pubkey(Keypair.generate().publicKey)
    .pubkey(attestor.publicKey)
    .pubkey(Keypair.generate().publicKey)
    .pubkey(PublicKey.default)
    .u32(900)
    .pubkey(DEVNET_MUSDC_MINT)
    .bool(false)
    .u8(255)
    .toBuffer()
}

/** GameMarket fields set by propose, challenge and finalize. */
interface Settled {
  outcome?: number
  evidence?: Uint8Array
  proposedAt?: number
  challenges?: number
  finalizedAt?: number
}

function gameMarketBytes(marketId: bigint, status: number, x: Settled = {}): Buffer {
  return new BorshWriter()
    .fixed(Uint8Array.from(HORAGON_ACCOUNT_DISCRIMINATORS.GameMarket), 8)
    .pubkey(program.addresses(marketId).market)
    .u64(marketId)
    .u8(0)
    .fixed(asciiField('NBA', 8, 'league'), 8)
    .string('401910007', 16)
    .fixed(asciiField('CLE', 4, 'home'), 4)
    .fixed(asciiField('MEM', 4, 'away'), 4)
    .i64(S)
    .i64(END)
    .u64(300_000_000n)
    .u8(status)
    .option<number>(x.outcome ?? null, (w, v) => w.u8(v))
    .fixed(x.evidence ?? new Uint8Array(32), 32)
    .string('', 128)
    .i64(x.proposedAt ?? 0)
    .pubkey(PublicKey.default)
    .u8(x.challenges ?? 0)
    .i64(x.finalizedAt ?? 0)
    .u8(255)
    .toBuffer()
}

/** One pino line, as the keeper wrote it. */
interface LogLine {
  level: number
  msg: string
  [k: string]: unknown
}
const WARN = 40
const ERROR = 50

let h: DbHandle
let now: number
let current: FeedGame
let feedDown: boolean
let skipped: number | undefined
/** When set, the fake sender throws what it returns for a label. */
let fail: ((label: string) => Error | undefined) | undefined
let settled: Settled
let accounts: Map<string, AccountInfo<Buffer>>
let sends: string[]
let specs: SendSpec[]
/** isDone answers the fake sender found wrong: done before the send, or not done after it. */
let doneProblems: string[]
/** Every fetchDay call, failed or not. */
let fetches: string[]
let alerts: Array<[string, string]>
let logs: LogLine[]
let marketId: bigint
let gm: string
let deps: KeeperDeps
let keeper: Keeper

const QUARTERS: Array<[number, number]> = [
  [30, 25],
  [28, 27],
  [26, 30],
  [27, 24],
]

const finalGame = (): FeedGame => ({
  ...current,
  status: 'final',
  period: 4,
  clockSecs: null,
  homeScore: 111,
  awayScore: 106,
  periods: QUARTERS,
})

const connectionOf = (k: Keeper) =>
  (k as unknown as { d: { sender: { connection: Record<string, unknown> } } }).d.sender.connection

const types = (actions: Array<{ type: string }>) => actions.map((a) => a.type)

/** Create, halt on the Final, then draft it 60 s later. */
async function toDraft(): Promise<void> {
  expect(types(await keeper.tick())).toEqual(['create'])
  now = END - 900
  current = finalGame()
  expect(types(await keeper.tick())).toEqual(['halt'])
  now += 60
  expect(types(await keeper.tick())).toEqual(['draft'])
}

beforeEach(async () => {
  h = await createTestDb()
  now = S - 3_600
  feedDown = false
  skipped = undefined
  fail = undefined
  settled = {}
  sends = []
  specs = []
  doneProblems = []
  fetches = []
  alerts = []
  logs = []
  marketId = await marketIdFor('NBA', '401910007', 0)
  accounts = new Map([[program.config.toBase58(), account(configBytes())]])
  current = {
    league: 'NBA',
    externalId: '401910007',
    gameDate: '2026-11-18',
    home: 'CLE',
    away: 'MEM',
    tipoff: new Date(S * 1000),
    status: 'scheduled',
    period: 0,
    clockSecs: null,
    homeScore: 0,
    awayScore: 0,
    periods: [],
    cup: false,
  }
  await upsertScheduledGames(h.db, [
    {
      id: 'nba-401910007',
      league: 'NBA',
      externalId: '401910007',
      gameDate: '2026-11-18',
      home: 'CLE',
      away: 'MEM',
      scheduledTipoff: new Date(S * 1000),
      status: 'scheduled',
      p0: 0.62,
    },
  ])
  const connection = {
    async getAccountInfo(k: PublicKey) {
      return accounts.get(k.toBase58()) ?? null
    },
    async getMultipleAccountsInfo(ks: PublicKey[]) {
      return ks.map((k) => accounts.get(k.toBase58()) ?? null)
    },
    async getTokenAccountBalance() {
      return { context: { slot: 1 }, value: { amount: '5000000000', decimals: 6, uiAmount: 5000 } }
    },
  } as unknown as Connection
  gm = deriveGameMarket(marketId, program.programId).toBase58()
  const sender = {
    connection,
    async send(spec: SendSpec) {
      sends.push(spec.label)
      specs.push(spec)
      // The real sender asks isDone before every retry: it must say no until the effect lands.
      if (await spec.isDone?.()) doneProblems.push(`${spec.label}: done before it was sent`)
      const failure = fail?.(spec.label)
      if (failure) throw failure
      // What the program would do: create opens the GameMarket, halt halts it.
      if (spec.label.startsWith('create'))
        accounts.set(gm, account(gameMarketBytes(marketId, STATUS.open)))
      if (spec.label.startsWith('halt'))
        accounts.set(gm, account(gameMarketBytes(marketId, STATUS.halted)))
      // Finalize settles the proposed outcome, recycle closes the pool.
      if (spec.label.startsWith('finalize')) {
        settled = { ...settled, finalizedAt: now }
        accounts.set(gm, account(gameMarketBytes(marketId, STATUS.finalized, settled)))
      }
      if (spec.label.startsWith('recycle'))
        accounts.set(gm, account(gameMarketBytes(marketId, STATUS.recycled, settled)))
      if (!(await spec.isDone?.())) doneProblems.push(`${spec.label}: not done after it landed`)
      return { signature: `sig${sends.length}`, attempts: 1, alreadyDone: false }
    },
  } as unknown as TxSender
  const feed: Feed = {
    name: 'fake',
    async fetchDay(date) {
      fetches.push(date)
      if (feedDown) throw new Error('espn answered 503')
      const onDate = date === current.gameDate
      return {
        source: 'espn',
        url: `https://site.api.espn.com/scoreboard?dates=${date}`,
        fetchedAt: new Date(now * 1000),
        games: onDate ? [current] : [],
        ...(onDate && skipped !== undefined ? { skipped } : {}),
      }
    },
  }
  deps = {
    db: h.db,
    sender,
    program,
    attestor,
    feed,
    alerts: { send: async (k, t) => void alerts.push([k, t]) },
    // Warnings and errors are kept for the assertions; nothing is printed.
    log: pino({ level: 'warn' }, { write: (line: string) => void logs.push(JSON.parse(line)) }),
    now: () => now,
    timings: DEFAULT_TIMINGS,
    seeds: DEFAULT_SEEDS,
    sigma: 13,
    priority: { normal: 10_000, halt: 200_000 },
    feedEverySecs: 0,
  }
  keeper = new Keeper(deps)
})
afterEach(async () => {
  await h.close()
  expect(doneProblems).toEqual([])
})

describe('Keeper.tick', () => {
  it('runs a game from create to draft', async () => {
    // S - 60 min: create.
    expect((await keeper.tick()).map((a) => a.type)).toEqual(['create'])
    expect(sends).toEqual(['create nba-401910007'])
    const created = await getGame(h.db, 'nba-401910007')
    expect(created?.markets[0]).toMatchObject({
      marketId: marketId.toString(),
      status: 'open',
      initialPriceBps: 6_200,
    })
    expect((await listOps(h.db)).map((o) => o.action)).toEqual(['create'])

    // A second tick is idempotent.
    expect(await keeper.tick()).toEqual([])

    // Live: the row follows the feed and gets a model probability and a snapshot.
    now = S + 600
    current = {
      ...current,
      status: 'live',
      period: 1,
      clockSecs: 400,
      homeScore: 10,
      awayScore: 8,
      periods: [[10, 8]],
    }
    await keeper.tick()
    const live = await getGame(h.db, 'nba-401910007')
    expect(live).toMatchObject({ status: 'live', homeScore: 10, period: 1 })
    expect(live?.modelProb).toBeGreaterThan(0.62)
    expect(await listSnapshots(h.db, 'nba-401910007')).toHaveLength(1)

    // Final before end_ts: halt.
    now = END - 900
    current = {
      ...current,
      status: 'final',
      period: 4,
      clockSecs: null,
      homeScore: 111,
      awayScore: 106,
      periods: QUARTERS,
    }
    expect((await keeper.tick()).map((a) => a.type)).toEqual(['halt'])
    expect(sends.at(-1)).toBe('halt nba-401910007 (final-before-end)')
    expect(alerts.map(([k]) => k)).toContain('halt:nba-401910007')

    // 60 s of the same Final: draft, and the guardian gets the exact command.
    now += 60
    expect((await keeper.tick()).map((a) => a.type)).toEqual(['draft'])
    expect(await getDraft(h.db, 'nba-401910007')).toMatchObject({
      status: 'final',
      homeScore: 111,
      state: 'pending',
    })
    // The key carries the challenge count (0 before any challenge): each round alerts apart.
    const [, text] = alerts.find(([k]) => k === 'draft:nba-401910007:0') ?? []
    expect(text).toContain('horagon-ops propose nba-401910007 --box-score <url> --score 111-106')

    // Every action went through: nothing was logged as failed.
    expect(logs).toEqual([])
  })

  it('keeps ticking when the feed is down', async () => {
    feedDown = true
    expect((await keeper.tick()).map((a) => a.type)).toEqual(['create'])
  })

  it('seeds a featured game at 300 and alerts when the treasury is short', async () => {
    await setFeatured(h.db, '2026-11-18', ['nba-401910007'])
    const conn = (keeper as unknown as { d: { sender: { connection: Record<string, unknown> } } }).d
      .sender.connection
    conn.getTokenAccountBalance = async () => ({
      context: { slot: 1 },
      value: { amount: '500000000' },
    })
    await keeper.tick()
    expect((await getGame(h.db, 'nba-401910007'))?.markets[0]?.seedAmount).toBe(300_000_000n)
    expect(alerts.map(([k]) => k)).toContain('treasury-low')
  })
})

describe('a challenge', () => {
  const ID = 'nba-401910007'
  const row = async () => (await getGame(h.db, ID))?.markets[0]
  /** Keys carry the on-chain challenge count, so a second round is never deduped away. */
  const challengeAlerts = () => alerts.filter(([k]) => k.startsWith(`challenge:${ID}:`))
  const challengeKeys = () => challengeAlerts().map(([k]) => k)

  /** The guardian proposes the pending draft; ops marks the draft proposed. */
  const propose = () => setDraftState(h.db, ID, { state: 'proposed' })

  /** Round one: propose, a challenge before the next tick, then the keeper's redraft. */
  async function firstChallenge(): Promise<void> {
    await toDraft()
    await propose()
    await updateMarket(h.db, program.addresses(marketId).market.toBase58(), { status: 'proposed' })
    settled = {
      outcome: 0,
      evidence: new Uint8Array(32).fill(0xab),
      proposedAt: now,
      challenges: 1,
    }
    accounts.set(gm, account(gameMarketBytes(marketId, STATUS.challenged, settled)))
    now += 5
    expect(types(await keeper.tick())).toEqual(['sync'])
    expect((await getDraft(h.db, ID))?.state).toBe('rejected')
    now += 5
    expect(types(await keeper.tick())).toEqual(['draft'])
    expect((await getDraft(h.db, ID))?.state).toBe('pending')
  }

  it('rejects the draft, so the next tick drafts again from the feed', async () => {
    await toDraft()

    // The guardian proposes from the draft; someone challenges before the next tick, and ESPN
    // corrects the score (the reason for the challenge).
    await propose()
    await updateMarket(h.db, program.addresses(marketId).market.toBase58(), { status: 'proposed' })
    accounts.set(
      gm,
      account(gameMarketBytes(marketId, STATUS.challenged, { proposedAt: now, challenges: 1 })),
    )
    current = {
      ...current,
      homeScore: 113,
      periods: [
        [30, 25],
        [28, 27],
        [26, 30],
        [29, 24],
      ],
    }

    now += 5
    expect((await keeper.tick()).map((a) => a.type)).toEqual(['sync'])
    expect((await getDraft(h.db, ID))?.state).toBe('rejected')
    expect(await row()).toMatchObject({ status: 'challenged', challengeCount: 1 })
    expect(challengeKeys()).toEqual([`challenge:${ID}:1`])
    expect(challengeAlerts()[0]?.[1]).toContain('propose again')

    // The corrected Final, stable for 60 s: a new pending draft for the guardian.
    now += 60
    expect((await keeper.tick()).map((a) => a.type)).toEqual(['draft'])
    expect(await getDraft(h.db, ID)).toMatchObject({
      status: 'final',
      homeScore: 113,
      awayScore: 106,
      state: 'pending',
    })
    const drafts = alerts.filter(([k]) => k.startsWith(`draft:${ID}:`))
    expect(drafts.map(([k]) => k)).toEqual([`draft:${ID}:0`, `draft:${ID}:1`])
    expect(drafts[1]?.[1]).toContain('--score 113-106')

    // Once drafted again, the challenged market stays quiet: no second rejection.
    now += 5
    expect(await keeper.tick()).toEqual([])
    expect((await getDraft(h.db, ID))?.state).toBe('pending')
  })

  it('rejects again when a second challenge lands before the keeper reads the chain', async () => {
    await firstChallenge()
    expect(challengeAlerts()).toHaveLength(1)

    // The guardian proposes the redraft and it is challenged again, all between two chain
    // reads: the row still says challenged, like the chain, but the count moved.
    await propose()
    const P2 = now + 30
    settled = { outcome: 1, evidence: new Uint8Array(32).fill(0xcd), proposedAt: P2, challenges: 2 }
    accounts.set(gm, account(gameMarketBytes(marketId, STATUS.challenged, settled)))
    now += 90
    expect(types(await keeper.tick())).toEqual(['sync'])
    expect((await getDraft(h.db, ID))?.state).toBe('rejected')
    // Within 600 s of the first, the second round still has a key of its own.
    expect(challengeKeys()).toEqual([`challenge:${ID}:1`, `challenge:${ID}:2`])
    expect(await row()).toMatchObject({
      status: 'challenged',
      challengeCount: 2,
      proposedAt: new Date(P2 * 1000),
      evidenceHash: 'cd'.repeat(32),
    })

    // The next tick drafts again from the feed.
    now += 5
    expect(types(await keeper.tick())).toEqual(['draft'])
    expect((await getDraft(h.db, ID))?.state).toBe('pending')
    expect(alerts.map(([k]) => k).filter((k) => k.startsWith(`draft:${ID}:`))).toEqual([
      `draft:${ID}:0`,
      `draft:${ID}:1`,
      `draft:${ID}:2`,
    ])
    now += 5
    expect(await keeper.tick()).toEqual([])
    expect(challengeAlerts()).toHaveLength(2)
  })

  it('says so when a challenge and a re-proposal both land between two chain reads', async () => {
    await firstChallenge()
    // The guardian proposes the redraft and the keeper sees it land: no alert for that.
    await propose()
    const P2 = now + 10
    settled = { outcome: 0, evidence: new Uint8Array(32).fill(0xcd), proposedAt: P2, challenges: 1 }
    accounts.set(gm, account(gameMarketBytes(marketId, STATUS.proposed, settled)))
    now += 20
    expect(types(await keeper.tick())).toEqual(['sync'])
    expect(challengeKeys()).toEqual([`challenge:${ID}:1`])

    // A second challenge, then a third proposal, both before the next chain read: the chain is
    // proposed again with a higher count. The alert must not ask for a proposal.
    const P3 = now + 60
    settled = { outcome: 0, evidence: new Uint8Array(32).fill(0xef), proposedAt: P3, challenges: 2 }
    accounts.set(gm, account(gameMarketBytes(marketId, STATUS.proposed, settled)))
    now += 90
    expect(types(await keeper.tick())).toEqual(['sync'])
    expect(challengeKeys()).toEqual([`challenge:${ID}:1`, `challenge:${ID}:2`])
    const text = challengeAlerts()[1]?.[1] ?? ''
    expect(text).toContain('was challenged and has been re-proposed')
    expect(text).not.toContain('propose again')
    expect(await row()).toMatchObject({ status: 'proposed', challengeCount: 2 })
  })

  it('reminds about a redraft under a key of its own round', async () => {
    await firstChallenge()
    now += DEFAULT_TIMINGS.missingSourceSecs
    expect(types(await keeper.tick())).toEqual(['alert'])
    expect(alerts.map(([k]) => k).filter((k) => k.startsWith('unconfirmed:'))).toEqual([
      `unconfirmed:${ID}:1`,
    ])
  })

  it('leaves a proposed draft alone while its propose has not landed', async () => {
    // Halted, no challenge yet: ops marked the draft proposed ahead of the transaction.
    await toDraft()
    await propose()
    now += 5
    expect(await keeper.tick()).toEqual([])
    expect((await getDraft(h.db, ID))?.state).toBe('proposed')
    expect(challengeAlerts()).toEqual([])
  })

  it('leaves a proposed redraft alone on a challenged chain whose count has not moved', async () => {
    await firstChallenge()
    await propose()
    now += 5
    expect(await keeper.tick()).toEqual([])
    expect((await getDraft(h.db, ID))?.state).toBe('proposed')
    expect(challengeAlerts()).toHaveLength(1)
  })
})

describe('a market on chain with no row', () => {
  const row = async () => (await getGame(h.db, 'nba-401910007'))?.markets[0]

  it('is adopted with its chain status, without reading the treasury', async () => {
    accounts.set(gm, account(gameMarketBytes(marketId, STATUS.halted)))
    let reads = 0
    connectionOf(keeper).getTokenAccountBalance = async () => {
      reads++
      return { context: { slot: 1 }, value: { amount: '0', decimals: 6, uiAmount: 0 } }
    }
    expect(types(await keeper.tick())).toEqual(['create'])
    expect(sends).toEqual([])
    expect(alerts).toEqual([])
    expect(reads).toBe(0)
    expect((await listOps(h.db)).map((o) => o.action)).toEqual(['adopt'])
    expect(await row()).toMatchObject({
      marketId: marketId.toString(),
      status: 'halted',
      seedAmount: 300_000_000n,
      endTs: new Date(END * 1000),
      createSig: null,
    })
    now += 5
    expect(await keeper.tick()).toEqual([])
  })

  it('is adopted on the next tick after a create that landed unresolved', async () => {
    fail = (label) => {
      // The transaction lands after the sender gave up on it.
      accounts.set(gm, account(gameMarketBytes(marketId, STATUS.open)))
      return new UnresolvedAttempt(`${label}: still unresolved after 90 s; it may still land`)
    }
    expect(types(await keeper.tick())).toEqual(['create'])
    expect(await row()).toBeUndefined()

    // The seed has left the treasury: a create would now report it empty.
    fail = undefined
    connectionOf(keeper).getTokenAccountBalance = async () => ({
      context: { slot: 1 },
      value: { amount: '0', decimals: 6, uiAmount: 0 },
    })
    now += 5
    expect(types(await keeper.tick())).toEqual(['create'])
    expect(sends).toEqual(['create nba-401910007'])
    expect(alerts).toEqual([])
    expect((await listOps(h.db)).map((o) => o.action)).toEqual(['adopt'])
    expect(await row()).toMatchObject({ status: 'open' })
  })
})

describe('isDone', () => {
  it('does not count a GameMarket the RPC cannot see as done', async () => {
    await keeper.tick() // create
    now = END - 900
    current = finalGame()
    await keeper.tick() // halt
    settled = { outcome: 0, proposedAt: END }
    accounts.set(gm, account(gameMarketBytes(marketId, STATUS.proposed, settled)))
    now = END + 900
    expect(types(await keeper.tick())).toEqual(['sync', 'finalize'])

    // A lagging RPC answers with no account.
    accounts.delete(gm)
    const labels = [
      'create nba-401910007',
      'halt nba-401910007 (final-before-end)',
      'finalize nba-401910007',
    ]
    for (const label of labels) {
      const spec = specs.find((x) => x.label === label)
      expect(spec, label).toBeDefined()
      expect(await spec?.isDone?.(), label).toBe(false)
    }
  })
})

describe('a GameMarket that does not decode', () => {
  it('is skipped with a warning and an alert, and the other games go on', async () => {
    const other = 'nba-401910008'
    await upsertScheduledGames(h.db, [
      {
        id: other,
        league: 'NBA',
        externalId: '401910008',
        gameDate: '2026-11-18',
        home: 'BOS',
        away: 'NYK',
        scheduledTipoff: new Date(S * 1000),
        status: 'scheduled',
        p0: 0.5,
      },
    ])
    const otherId = await marketIdFor('NBA', '401910008', 0)
    const a = program.addresses(otherId)
    await upsertMarket(h.db, {
      pubkey: a.market.toBase58(),
      gameId: other,
      kind: 0,
      marketId: otherId.toString(),
      gameMarketPda: a.gameMarket.toBase58(),
      yesMint: a.yesMint.toBase58(),
      noMint: a.noMint.toBase58(),
      initialPriceBps: 5_000,
      endTs: new Date(END * 1000),
      seedAmount: 300_000_000n,
      status: 'open',
    })
    accounts.set(a.gameMarket.toBase58(), account(Buffer.from('not a GameMarket at all')))

    expect(types(await keeper.tick())).toEqual(['create'])
    expect(sends).toEqual(['create nba-401910007'])
    expect(alerts.map(([k]) => k)).toEqual([`decode:${other}`])
    expect(alerts[0]?.[1]).toContain('account is not a GameMarket')
    const warns = logs.filter((l) => l.level === WARN)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ gameId: other })
  })
})

describe('the feed', () => {
  it('is polled no faster than feedEverySecs, even while it fails', async () => {
    const throttled = new Keeper({ ...deps, feedEverySecs: 15 })
    feedDown = true
    await throttled.tick()
    expect(fetches).toEqual(['2026-11-17', '2026-11-18'])
    now += 14
    await throttled.tick()
    expect(fetches).toHaveLength(2)
    now += 1
    await throttled.tick()
    expect(fetches).toHaveLength(4)
  })
})

describe('a pending draft', () => {
  it('reminds the guardian once after 30 min unconfirmed', async () => {
    await toDraft()
    const key = 'unconfirmed:nba-401910007:0'
    now += DEFAULT_TIMINGS.missingSourceSecs - 61
    expect(await keeper.tick()).toEqual([])
    now += 1
    expect(types(await keeper.tick())).toEqual(['alert'])
    expect(alerts.filter(([k]) => k === key)).toHaveLength(1)
    expect((await getDraft(h.db, 'nba-401910007'))?.alertedAt).toBeInstanceOf(Date)
    now += 5
    expect(await keeper.tick()).toEqual([])
  })
})

describe('settlement', () => {
  it('finalizes after the dispute window, recycles, and copies each step into the row', async () => {
    await keeper.tick() // create
    const row = async () => (await getGame(h.db, 'nba-401910007'))?.markets[0]

    // The guardian proposed YES at P; the Config's dispute window is 900 s.
    const P = END + 600
    settled = { outcome: 0, evidence: new Uint8Array(32).fill(0xab), proposedAt: P }
    accounts.set(gm, account(gameMarketBytes(marketId, STATUS.proposed, settled)))
    now = P + 899
    expect(types(await keeper.tick())).toEqual(['sync'])
    expect(await row()).toMatchObject({
      status: 'proposed',
      outcome: null,
      evidenceHash: 'ab'.repeat(32),
      proposedAt: new Date(P * 1000),
      finalizedAt: null,
    })

    now = P + 900
    expect(types(await keeper.tick())).toEqual(['finalize'])
    expect(sends.at(-1)).toBe('finalize nba-401910007')
    expect(await row()).toMatchObject({
      status: 'finalized',
      outcome: 'yes',
      finalizeSig: 'sig2',
      finalizedAt: new Date(now * 1000),
      recycledAt: null,
    })

    now += 5
    expect(types(await keeper.tick())).toEqual(['recycle'])
    expect(await row()).toMatchObject({ status: 'recycled', outcome: 'yes', recycleSig: 'sig3' })
    expect((await row())?.recycledAt).toBeInstanceOf(Date)

    now += 5
    expect(await keeper.tick()).toEqual([])
    expect((await listOps(h.db)).map((o) => o.action)).toEqual(['recycle', 'finalize', 'create'])
    expect(logs).toEqual([])
  })
})

describe('the evidence on chain', () => {
  const GAME = 'nba-401910007'
  const P = END + 600
  const mismatches = () => alerts.filter(([k]) => k.startsWith('evidence-mismatch:'))

  /** A proposal with evidence 0xab… lands; the stored evidence row has `stored` (or none). */
  async function landed(stored: string | null): Promise<void> {
    expect(types(await keeper.tick())).toEqual(['create'])
    if (stored) await putEvidence(h.db, { gameId: GAME, kind: 0, json: '{}', hash: stored })
    settled = { outcome: 0, evidence: new Uint8Array(32).fill(0xab), proposedAt: P }
    accounts.set(gm, account(gameMarketBytes(marketId, STATUS.proposed, settled)))
    now = P + 5
    expect(types(await keeper.tick())).toEqual(['sync'])
  }

  it('alerts when the stored evidence is not the one on chain, with both hashes', async () => {
    await landed('cd'.repeat(32))
    expect(mismatches().map(([k]) => k)).toEqual([`evidence-mismatch:${GAME}`])
    const text = mismatches()[0]?.[1] ?? ''
    expect(text).toContain(`sha256 ${'ab'.repeat(32)} on chain`)
    expect(text).toContain(`serves sha256 ${'cd'.repeat(32)}`)
    // Read on a sync only: the next ticks neither read nor alert again.
    now += 5
    expect(await keeper.tick()).toEqual([])
    expect(mismatches()).toHaveLength(1)
  })

  it('alerts when nothing is stored for the hash on chain', async () => {
    await landed(null)
    expect(mismatches()).toHaveLength(1)
    expect(mismatches()[0]?.[1]).toContain('serves no evidence')
  })

  it('stays quiet when the hashes match, through the finalize as well', async () => {
    await landed('ab'.repeat(32))
    now = P + 900
    expect(types(await keeper.tick())).toEqual(['finalize'])
    expect(mismatches()).toEqual([])
  })
})

describe('a failed action', () => {
  it('is logged, alerted when the program rejects it, and does not stop the others', async () => {
    expect(types(await keeper.tick())).toEqual(['create'])
    fail = (label) =>
      label.startsWith('halt')
        ? new ProgramFailure(label, 'horagon', 6004, 'MarketNotOpen', ['Program log: detail'])
        : undefined
    now = END - 900
    current = finalGame()
    expect(types(await keeper.tick())).toEqual(['halt'])

    // Still open, so the halt is tried again; the draft goes out all the same.
    now += 60
    expect(types(await keeper.tick())).toEqual(['halt', 'draft'])
    expect((await getDraft(h.db, 'nba-401910007'))?.state).toBe('pending')
    expect(alerts.filter(([k]) => k === 'fail:halt:nba-401910007')).toEqual([
      [
        'fail:halt:nba-401910007',
        'halt nba-401910007 rejected: halt nba-401910007 (final-before-end): horagon error MarketNotOpen',
      ],
      [
        'fail:halt:nba-401910007',
        'halt nba-401910007 rejected: halt nba-401910007 (final-before-end): horagon error MarketNotOpen',
      ],
    ])
    const errors = logs.filter((l) => l.level === ERROR)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatchObject({
      msg: 'action failed',
      action: 'halt',
      gameId: 'nba-401910007',
    })
    expect(errors[0]).not.toHaveProperty('stack')
    expect(errors[0]).not.toHaveProperty('err')
  })

  it('redacts the rejection it alerts', async () => {
    fail = (label) =>
      new ProgramFailure(
        label,
        'horagon',
        null,
        'see https://rpc.example.test/?api-key=SECRET123',
        [],
      )
    await keeper.tick()
    expect(alerts.map(([k]) => k)).toEqual(['fail:create:nba-401910007'])
    expect(alerts[0]?.[1]).toContain('create nba-401910007 rejected: create nba-401910007: horagon')
    expect(JSON.stringify(alerts)).not.toContain('SECRET123')
  })

  it('logs any other failure without a keyed URL and without an alert', async () => {
    fail = () => new Error('fetch failed: https://rpc.example.test/v1/SECRET123?api-key=SECRET123')
    expect(types(await keeper.tick())).toEqual(['create'])
    expect(sends).toEqual(['create nba-401910007'])
    expect(alerts).toEqual([])
    const errors = logs.filter((l) => l.level === ERROR)
    expect(errors).toHaveLength(1)
    expect(String(errors[0]?.error)).toContain('fetch failed')
    expect(JSON.stringify(logs)).not.toContain('SECRET123')

    // Nothing was recorded, so the next tick tries again.
    expect((await getGame(h.db, 'nba-401910007'))?.markets).toEqual([])
    fail = undefined
    now += 5
    expect(types(await keeper.tick())).toEqual(['create'])
    expect(sends).toEqual(['create nba-401910007', 'create nba-401910007'])
  })
})

describe('skipped feed events', () => {
  it('alerts once when the feed could not read some events of a date', async () => {
    skipped = 2
    await keeper.tick()
    expect(alerts).toEqual([
      ['feed-skipped:2026-11-18', '2 ESPN events on 2026-11-18 could not be read; check the feed'],
    ])
  })

  it('stays quiet when nothing was skipped', async () => {
    skipped = 0
    await keeper.tick()
    skipped = undefined
    now += 5
    await keeper.tick()
    expect(alerts).toEqual([])
  })
})

describe('the treasury read before a create', () => {
  it('skips the create without an alert when the RPC cannot answer', async () => {
    const conn = connectionOf(keeper)
    const balance = conn.getTokenAccountBalance
    conn.getTokenAccountBalance = async () => {
      throw new Error('429 Too Many Requests from https://rpc.example.test/?api-key=SECRET123')
    }
    expect((await keeper.tick()).map((a) => a.type)).toEqual(['create'])
    expect(sends).toEqual([])
    expect(alerts).toEqual([])
    expect((await getGame(h.db, 'nba-401910007'))?.markets).toEqual([])
    const warns = logs.filter((l) => l.level === WARN)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatchObject({ gameId: 'nba-401910007' })
    expect(String(warns[0]?.error)).toContain('429')
    expect(JSON.stringify(logs)).not.toContain('SECRET123')

    // The RPC answers again: the planner asks for the create once more, and it goes out.
    conn.getTokenAccountBalance = balance
    now += 5
    expect((await keeper.tick()).map((a) => a.type)).toEqual(['create'])
    expect(sends).toEqual(['create nba-401910007'])
    expect(alerts).toEqual([])
  })

  it('alerts after 10 failed reads in a row, and counts again after a good read', async () => {
    const conn = connectionOf(keeper)
    const failing = async () => {
      throw new Error('429 Too Many Requests from https://rpc.example.test/?api-key=SECRET123')
    }
    const unread = () => alerts.filter(([k]) => k === 'treasury-unread')
    const ticks = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await keeper.tick()
        now += 5
      }
    }
    conn.getTokenAccountBalance = failing
    await ticks(9)
    expect(unread()).toEqual([])
    await ticks(1)
    expect(unread()).toHaveLength(1)
    expect(unread()[0]?.[1]).toContain('10 times in a row')
    expect(unread()[0]?.[1]).toContain('429 Too Many Requests')
    expect(JSON.stringify(alerts)).not.toContain('SECRET123')
    expect(sends).toEqual([])

    // A good read (an empty treasury) resets the count.
    conn.getTokenAccountBalance = async () => ({
      context: { slot: 1 },
      value: { amount: '0', decimals: 6, uiAmount: 0 },
    })
    await ticks(1)
    conn.getTokenAccountBalance = failing
    await ticks(9)
    expect(unread()).toHaveLength(1)
    await ticks(1)
    expect(unread()).toHaveLength(2)
  })

  it('treats a treasury account that does not exist as empty', async () => {
    connectionOf(keeper).getTokenAccountBalance = async () => {
      throw new Error('failed to get token account balance: Invalid param: could not find account')
    }
    await keeper.tick()
    expect(sends).toEqual([])
    expect(alerts).toEqual([
      ['treasury-empty:nba-401910007', 'Treasury 0 mUSDC: cannot seed nba-401910007'],
    ])
    expect(logs).toEqual([])
  })
})

describe('stuckAlerts', () => {
  const STUCK = END + 6 * 3600
  const KEY = 'stuck:nba-401910007'
  const TEXT = 'MEM@CLE: market closed over 6 h ago with no result draft; resolve by hand'

  function draft(state: string): DraftRow {
    return {
      gameId: 'nba-401910007',
      status: 'final',
      homeScore: 111,
      awayScore: 106,
      periods: QUARTERS,
      sourceUrl: 'https://site.api.espn.com/scoreboard?dates=20261118',
      fetchedAt: new Date(END * 1000),
      state,
      alertedAt: null,
      createdAt: new Date(END * 1000),
    }
  }

  async function state(
    patch: Partial<GameState> = {},
    status: number = STATUS.open,
  ): Promise<GameState> {
    const game = await getGame(h.db, 'nba-401910007')
    if (!game) throw new Error('the seeded game is missing')
    return {
      game,
      market: null,
      onchain: decodeGameMarket(account(gameMarketBytes(marketId, status)), program.programId),
      feed: { ...current, status: 'live', period: 3, clockSecs: 200, homeScore: 70, awayScore: 66 },
      feedSeenAt: S + 5_000,
      finalSince: null,
      draft: null,
      ...patch,
    }
  }

  it('alerts from 6 h after the close, not before', async () => {
    const s = await state()
    expect(stuckAlerts([s], STUCK - 1)).toEqual([])
    expect(stuckAlerts([s], STUCK)).toEqual([
      { type: 'alert', gameId: 'nba-401910007', key: KEY, text: TEXT },
    ])
  })

  it('covers an open, halted or challenged market with a live, final or missing feed', async () => {
    for (const status of [STATUS.open, STATUS.halted, STATUS.challenged]) {
      for (const feed of [null, { ...current, status: 'live' as const }, finalGame()]) {
        expect(stuckAlerts([await state({ feed }, status)], STUCK)).toHaveLength(1)
      }
    }
  })

  it('counts a rejected draft as no draft', async () => {
    expect(stuckAlerts([await state({ draft: draft('rejected') })], STUCK)).toHaveLength(1)
  })

  it('stays quiet with a usable draft', async () => {
    expect(stuckAlerts([await state({ draft: draft('pending') })], STUCK)).toEqual([])
    expect(stuckAlerts([await state({ draft: draft('proposed') })], STUCK)).toEqual([])
  })

  it('counts a proposed draft as no draft while the chain is challenged', async () => {
    const proposed = { draft: draft('proposed') }
    expect(stuckAlerts([await state(proposed, STATUS.challenged)], STUCK)).toHaveLength(1)
    expect(stuckAlerts([await state(proposed, STATUS.halted)], STUCK)).toEqual([])
    const pending = { draft: draft('pending') }
    expect(stuckAlerts([await state(pending, STATUS.challenged)], STUCK)).toEqual([])
  })

  it('leaves postponed, canceled and scheduled games to the 7-day path', async () => {
    for (const status of ['postponed', 'canceled', 'scheduled'] as const) {
      expect(stuckAlerts([await state({ feed: { ...current, status } })], STUCK)).toEqual([])
    }
  })

  it('ignores a market already proposed or settled, and a game without one', async () => {
    for (const status of [STATUS.proposed, STATUS.finalized, STATUS.recycled]) {
      expect(stuckAlerts([await state({}, status)], STUCK)).toEqual([])
    }
    expect(stuckAlerts([await state({ onchain: null })], STUCK)).toEqual([])
  })

  it('is sent by tick and returned with its actions', async () => {
    await keeper.tick() // create
    now = S + 1_800
    current = {
      ...current,
      status: 'live',
      period: 2,
      clockSecs: 300,
      homeScore: 50,
      awayScore: 48,
    }
    await keeper.tick()

    // ESPN goes silent in Q2 and never comes back: no halt rule, no draft.
    feedDown = true
    now = STUCK - 1
    expect(await keeper.tick()).toEqual([])
    now = STUCK
    expect(await keeper.tick()).toEqual([
      { type: 'alert', gameId: 'nba-401910007', key: KEY, text: TEXT },
    ])
    expect(alerts).toContainEqual([KEY, TEXT])
  })
})

describe('minutesRemaining', () => {
  it('counts regulation down from 48 and overtime from 5', () => {
    expect(minutesRemaining({ status: 'scheduled', period: 0, clockSecs: null })).toBe(48)
    expect(minutesRemaining({ status: 'live', period: 1, clockSecs: 720 })).toBe(48)
    expect(minutesRemaining({ status: 'live', period: 4, clockSecs: 30 })).toBe(0.5)
    expect(minutesRemaining({ status: 'live', period: 5, clockSecs: 120 })).toBe(2)
    expect(minutesRemaining({ status: 'final', period: 4, clockSecs: 0 })).toBe(0)
  })
})
