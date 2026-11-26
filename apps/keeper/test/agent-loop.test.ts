import { Writable } from 'node:stream'
import {
  type DbHandle,
  getHeartbeat,
  insertTrades,
  updateGameLive,
  updateMarket,
  upsertMarket,
  upsertScheduledGames,
} from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import {
  ataAddress,
  DEVNET_MUSDC_MINT,
  deriveMarketPda,
  deriveNoMint,
  deriveYesMint,
  HoragonProgram,
  MEMO_PROGRAM_ID,
  PM_AMM_IX_DISCRIMINATORS,
  PM_AMM_PROGRAM_ID,
  SWAP_COMPUTE_UNITS,
} from '@horagon/sdk'
import { Keypair, type PublicKey } from '@solana/web3.js'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type AgentDeps, ReferenceAgent } from '../src/agent/agent'
import { type AgentParams, defaultAgentParams } from '../src/agent/config'
import type { Decision } from '../src/agent/decide'
import { UnresolvedAttempt } from '../src/executor'
import { FakeChain, FakeSender, type MarketFields, poolAt, tokenInfo } from './agent-fixtures'

const NOW = 1_795_003_600
const M = 1_000_000n
const program = new HoragonProgram({ collateralMint: DEVNET_MUSDC_MINT })
const agent = Keypair.generate()

interface LogLine {
  level: number
  msg: string
  [k: string]: unknown
}

let h: DbHandle
let clock: number
let chain: FakeChain
let sender: FakeSender
let alerts: Array<[string, string]>
let logs: LogLine[]
let faucetCalls: string[]
let faucetError: Error | null

beforeAll(async () => {
  h = await createTestDb()
})
afterAll(async () => {
  await h.close()
})
beforeEach(async () => {
  await h.db.execute(
    'truncate table trades, redeems_claims, markets, game_snapshots, resolution_drafts, evidence, keeper_heartbeats, games cascade',
  )
  clock = NOW
  chain = new FakeChain()
  sender = new FakeSender(chain.asConnection())
  alerts = []
  logs = []
  faucetCalls = []
  faucetError = null
})

function agentWith(o: { dryRun?: boolean; params?: Partial<AgentParams> } = {}): ReferenceAgent {
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split('\n')) if (line) logs.push(JSON.parse(line))
      cb()
    },
  })
  const deps: AgentDeps = {
    db: h.db,
    sender,
    wallet: agent.publicKey,
    collateralMint: DEVNET_MUSDC_MINT,
    alerts: {
      send: async (key, text) => {
        alerts.push([key, text])
      },
    },
    log: pino({ level: 'debug', base: { service: 'agent' } }, stream),
    params: { ...defaultAgentParams(), ...o.params },
    dryRun: o.dryRun ?? false,
    now: () => clock,
    faucet: async (wallet) => {
      faucetCalls.push(wallet)
      if (faucetError) throw faucetError
    },
    priorityMicroLamports: 10_000,
  }
  return new ReferenceAgent(deps)
}

/** A live NBA game with its open winner market (id `n`), and the market on the fake chain. */
async function liveMarket(
  n: number,
  o: { price?: number; model?: number; seed?: number; league?: string } = {},
): Promise<{ key: PublicKey; fields: MarketFields; gameId: string }> {
  const gameId = `nba-${n}`
  await upsertScheduledGames(h.db, [
    {
      id: gameId,
      league: o.league ?? 'NBA',
      externalId: String(n),
      gameDate: '2026-11-26',
      home: 'CLE',
      away: 'MEM',
      scheduledTipoff: new Date((NOW - 3_600) * 1000),
      status: 'scheduled',
      p0: 0.6,
    },
  ])
  await setModel(gameId, o.model ?? 0.7)
  const fields: MarketFields = {
    marketId: BigInt(n),
    authority: program.authority,
    pool: poolAt(o.price ?? 0.6, { now: NOW, remaining: 4_200, seed: o.seed ?? 300 }),
  }
  const key = chain.setMarket(fields)
  await upsertMarket(h.db, {
    pubkey: key.toBase58(),
    gameId,
    kind: 0,
    marketId: String(n),
    gameMarketPda: `gm-${n}`,
    yesMint: deriveYesMint(key).toBase58(),
    noMint: deriveNoMint(key).toBase58(),
    initialPriceBps: 6_000,
    endTs: new Date((NOW + 4_200) * 1000),
    seedAmount: 300n * M,
    status: 'open',
  })
  return { key, fields, gameId }
}

/** The keeper's tick writing a fresh model for the game, as of `clock`. */
async function setModel(gameId: string, modelProb: number, status = 'live'): Promise<void> {
  await updateGameLive(h.db, gameId, {
    status,
    homeScore: 50,
    awayScore: 45,
    period: 3,
    clockSecs: 300,
    periods: [],
    modelProb,
    feedUpdatedAt: new Date((clock - 5) * 1000),
  })
}

/** Moves the fake market's YES price, as a swap would. */
function movePrice(fields: MarketFields, price: number): void {
  chain.setMarket({
    ...fields,
    pool: poolAt(price, { now: NOW, remaining: 4_200, lZero: fields.pool.lZero }),
  })
}

const reasons = (ds: Decision[]) => ds.map((d) => (d.action === 'skip' ? d.reason : 'swap'))
const keys = () => alerts.map(([k]) => k)

describe('a dry run', () => {
  it('logs every decision and sends nothing', async () => {
    const { key } = await liveMarket(1)
    await liveMarket(2, { price: 0.6, model: 0.62 })
    const a = agentWith({ dryRun: true })
    const report = await a.round()
    const byGame = Object.fromEntries(report.decisions.map((d) => [d.gameId, reasons([d])[0]]))
    expect(byGame).toEqual({ 'nba-1': 'swap', 'nba-2': 'in-band' })
    expect(sender.specs).toEqual([])
    expect(faucetCalls).toEqual([])
    const swap = logs.find((l) => l.msg === 'agent swap')
    expect(swap).toMatchObject({
      market: key.toBase58(),
      gameId: 'nba-1',
      model: 0.7,
      side: 'yes',
      dryRun: true,
      level: 30,
    })
    expect(swap?.price as number).toBeCloseTo(0.6, 9)
    expect(swap?.gap as number).toBeCloseTo(0.1, 9)
    expect(Number(swap?.size)).toBeGreaterThan(1)
    expect(Math.abs((swap?.expectedPrice as number) - 0.68)).toBeLessThanOrEqual(0.005)
    const skip = logs.find((l) => l.msg === 'agent skip')
    expect(skip).toMatchObject({ gameId: 'nba-2', reason: 'in-band', level: 30 })
    // A second round sends nothing either.
    await a.round()
    expect(sender.specs).toEqual([])
  })
})

describe('a live round', () => {
  it('sends one swap per market with the bot memo, then checks it on the next read', async () => {
    const { key, fields } = await liveMarket(1)
    sender.onSend = () => movePrice(fields, 0.68)
    const a = agentWith()
    const first = await a.round()
    expect(first.sent).toBe(1)
    expect(sender.specs).toHaveLength(1)
    const spec = sender.specs[0]
    expect(spec?.label).toBe('swap nba-1')
    expect(spec?.computeUnits).toBe(SWAP_COMPUTE_UNITS)
    expect(spec?.signers).toBeUndefined()
    const programs = spec?.instructions.map((ix) => ix.programId) ?? []
    expect(programs.filter((p) => p.equals(MEMO_PROGRAM_ID))).toHaveLength(1)
    expect(programs.at(-1)?.equals(PM_AMM_PROGRAM_ID)).toBe(true)
    // The agent's YES and NO ATAs do not exist yet; its mUSDC ATA and the fee ATAs are not
    // on the fake chain either, so all five are created, paid by the agent.
    expect(spec?.instructions).toHaveLength(7)
    expect(logs.find((l) => l.msg === 'agent swap landed')).toMatchObject({
      market: key.toBase58(),
      sig: 'sig1',
    })
    // Next round: the price moved to the target, inside the band: nothing more to do.
    const second = await a.round()
    expect(reasons(second.decisions)).toEqual(['in-band'])
    expect(keys()).not.toContain('agent-anomaly:nba-1')
  })

  it('creates only the ATAs that are missing', async () => {
    const { key } = await liveMarket(1)
    for (const mint of [DEVNET_MUSDC_MINT, deriveYesMint(key), deriveNoMint(key)]) {
      chain.set(ataAddress({ owner: agent.publicKey, mint }), tokenInfo(mint, agent.publicKey, 1n))
    }
    for (const owner of [program.authority, (await import('@horagon/sdk')).PROTOCOL_DAO]) {
      chain.set(
        ataAddress({ owner, mint: DEVNET_MUSDC_MINT }),
        tokenInfo(DEVNET_MUSDC_MINT, owner, 1n),
      )
    }
    await agentWith().round()
    expect(sender.specs[0]?.instructions.map((ix) => ix.programId.toBase58())).toEqual([
      MEMO_PROGRAM_ID.toBase58(),
      PM_AMM_PROGRAM_ID.toBase58(),
    ])
    const swap = sender.specs[0]?.instructions[1]
    expect([...(swap?.data.subarray(0, 8) ?? [])]).toEqual([...PM_AMM_IX_DISCRIMINATORS.swap])
  })

  it('takes the wallet balance left after the earlier swaps of the round', async () => {
    await liveMarket(1, { seed: 1_000, price: 0.4, model: 0.95 })
    await liveMarket(2, { seed: 1_000, price: 0.4, model: 0.95 })
    chain.musdc = 120n * M
    const report = await agentWith().round()
    // The first market of the round (by end_ts, then address) takes the per-swap cap.
    const sizes = report.decisions.map((d) => (d.action === 'swap' ? d.amountIn : 0n))
    expect(sizes).toEqual([100n * M, 20n * M])
    expect(sender.specs.map((s) => s.label).sort()).toEqual(['swap nba-1', 'swap nba-2'])
  })

  it('steps aside while a fan has traded in the last 90 s', async () => {
    const { key } = await liveMarket(1)
    const trade = (wallet: string, ago: number, sig: string) => ({
      sig,
      ixIndex: 3,
      market: key.toBase58(),
      wallet,
      direction: 'usdcToYes',
      usdcAmount: 5n * M,
      usdcDelta: -5n * M,
      yesDelta: 7n * M,
      noDelta: 0n,
      fee: 100_000n,
      slot: 1n,
      blockTime: new Date((clock - ago) * 1000),
      botMemo: false,
    })
    // Its own trade 10 s ago does not count; a fan's 100 s ago is outside the window.
    await insertTrades(h.db, [
      trade(agent.publicKey.toBase58(), 10, 'own'),
      trade('FAN', 100, 'old'),
    ])
    const a = agentWith({ dryRun: true })
    expect(reasons((await a.round()).decisions)).toEqual(['swap'])
    await insertTrades(h.db, [trade('FAN', 30, 'fan')])
    expect(reasons((await a.round()).decisions)).toEqual(['fan-trade'])
  })

  it('counts its own swaps before the indexer does, and trusts the larger count', async () => {
    const { key } = await liveMarket(1)
    const a = agentWith({ params: { maxSwapsPerGame: 1 } })
    await a.round()
    expect(sender.specs).toHaveLength(1)
    // The price did not move (the indexer has not seen the swap either): the cap still holds.
    expect(reasons((await a.round()).decisions)).toEqual(['swap-count'])
    // A DB count above the process's own (an earlier run) wins as well.
    const b = agentWith()
    await insertTrades(h.db, [
      {
        sig: 'earlier',
        ixIndex: 3,
        market: key.toBase58(),
        wallet: agent.publicKey.toBase58(),
        direction: 'usdcToYes',
        usdcAmount: 2_000n * M,
        usdcDelta: -2_000n * M,
        yesDelta: 1n,
        noDelta: 0n,
        fee: 0n,
        slot: 1n,
        blockTime: new Date((clock - 600) * 1000),
        botMemo: true,
      },
    ])
    expect(reasons((await b.round()).decisions)).toEqual(['game-budget'])
  })

  it('counts a swap that may still land as spent', async () => {
    await liveMarket(1)
    sender.fail = new UnresolvedAttempt('swap nba-1: unresolved after 90 s')
    const a = agentWith({ params: { maxSwapsPerGame: 1 } })
    const first = await a.round()
    expect(first.failures).toBe(1)
    sender.fail = null
    expect(reasons((await a.round()).decisions)).toEqual(['swap-count'])
  })

  it('trades PRACTICE markets only with AGENT_PRACTICE=1', async () => {
    await liveMarket(1, { league: 'PRACTICE' })
    expect((await agentWith({ dryRun: true }).round()).decisions).toEqual([])
    const on = await agentWith({ dryRun: true, params: { practice: true } }).round()
    expect(reasons(on.decisions)).toEqual(['swap'])
  })

  it('writes its heartbeat', async () => {
    await liveMarket(1)
    await agentWith({ dryRun: true }).round()
    const hb = await getHeartbeat(h.db, 'agent')
    expect(hb?.info).toMatchObject({ round: 1, dryRun: true, markets: 1, sent: 0, disabled: [] })
  })
})

describe('the anomaly check', () => {
  it('disables a market whose price moved away from the model after the swap', async () => {
    const { key, fields } = await liveMarket(1)
    sender.onSend = () => movePrice(fields, 0.55)
    const a = agentWith()
    await a.round()
    const second = await a.round()
    expect(reasons(second.decisions)).toEqual(['disabled'])
    expect(keys()).toEqual(['agent-anomaly:nba-1'])
    expect(alerts[0]?.[1]).toContain('market disabled until the agent restarts')
    expect(logs.find((l) => l.msg === 'agent anomaly')).toMatchObject({
      market: key.toBase58(),
      priceBefore: expect.any(Number),
    })
    // Still disabled, and alerted once.
    expect(reasons((await a.round()).decisions)).toEqual(['disabled'])
    expect(keys()).toEqual(['agent-anomaly:nba-1'])
    expect(sender.specs).toHaveLength(1)
    // A new process (a restart) trades it again.
    expect(reasons((await agentWith().round()).decisions)).toEqual(['swap'])
  })

  it('does not blame the agent for the model moving on', async () => {
    const { fields, gameId } = await liveMarket(1)
    sender.onSend = () => movePrice(fields, 0.68)
    const a = agentWith()
    await a.round()
    // The game swung: the gap is now larger than before the swap, but the price moved toward
    // the model the swap was sized on.
    await setModel(gameId, 0.95)
    const second = await a.round()
    expect(keys()).toEqual([])
    expect(reasons(second.decisions)).toEqual(['swap'])
  })
})

describe('failures', () => {
  it('pauses 10 min after 5 failed sends in a row, and pages', async () => {
    const { gameId } = await liveMarket(1)
    sender.fail = new Error('fetch failed: https://rpc.example/?api-key=SECRET')
    const a = agentWith()
    for (let i = 1; i <= 4; i++) {
      expect((await a.round()).failures).toBe(1)
      expect(keys()).toEqual([])
    }
    await a.round()
    expect(keys()).toEqual(['agent-paused'])
    expect(alerts[0]?.[1]).toContain('paused 10 min after 5 failed reads or sends')
    expect(alerts[0]?.[1]).not.toContain('SECRET')
    expect(sender.specs).toHaveLength(5)
    // Paused: no read, no send.
    const reads = chain.reads
    expect((await a.round()).paused).toBe(true)
    expect(chain.reads).toBe(reads)
    clock += 599
    expect((await a.round()).paused).toBe(true)
    // After the pause it trades again.
    clock += 1
    await setModel(gameId, 0.7)
    sender.fail = null
    const after = await a.round()
    expect(after.paused).toBe(false)
    expect(after.sent).toBe(1)
  })

  it('counts failed reads, and a clean round ends the streak', async () => {
    await liveMarket(1)
    const a = agentWith({ dryRun: true })
    chain.fail.balance = new Error('rpc down')
    for (let i = 0; i < 4; i++) await a.round()
    expect(a.failures.count).toBe(4)
    chain.fail.balance = undefined
    await a.round()
    expect(a.failures.count).toBe(0)
    chain.fail.balance = new Error('rpc down')
    for (let i = 0; i < 4; i++) await a.round()
    expect(keys()).toEqual([])
    await a.round()
    expect(keys()).toEqual(['agent-paused'])
    expect(logs.some((l) => l.msg === 'agent read failed')).toBe(true)
  })
})

describe('balances, faucet and claims', () => {
  it('pages when the wallet runs low on SOL or mUSDC', async () => {
    await liveMarket(1)
    chain.lamports = 50_000_000
    chain.musdc = 150n * M
    await agentWith({ dryRun: true }).round()
    expect(keys()).toEqual(['agent-sol', 'agent-musdc'])
    expect(alerts[0]?.[1]).toContain('0.05 SOL')
    expect(alerts[1]?.[1]).toContain('150.00 mUSDC, under 200.00')
  })

  it('reads a missing mUSDC account as empty', async () => {
    await liveMarket(1)
    chain.musdc = null
    const report = await agentWith().round()
    expect(reasons(report.decisions)).toEqual(['balance'])
    expect(keys()).toContain('agent-musdc')
    expect(sender.specs).toEqual([])
  })

  it('claims the faucet at most once an hour; a refusal is only logged', async () => {
    const a = agentWith()
    faucetError = new Error('faucet answered 429')
    await a.round()
    expect(faucetCalls).toEqual([agent.publicKey.toBase58()])
    expect(logs.some((l) => l.msg === 'agent: faucet skipped')).toBe(true)
    expect(a.failures.count).toBe(0)
    clock += 3_599
    await a.round()
    expect(faucetCalls).toHaveLength(1)
    clock += 1
    faucetError = null
    await a.round()
    expect(faucetCalls).toHaveLength(2)
  })

  it('claims settled markets where it holds winning shares, without a memo', async () => {
    const wallet = agent.publicKey.toBase58()
    const settled = async (
      n: number,
      winningSide: number,
      yes: bigint | null,
      no: bigint | null,
    ) => {
      const { key, fields, gameId } = await liveMarket(n)
      await setModel(gameId, 1, 'final')
      await updateMarket(h.db, key.toBase58(), { status: 'finalized' })
      chain.setMarket({ ...fields, resolved: true, winningSide })
      const yesMint = deriveYesMint(key)
      const noMint = deriveNoMint(key)
      if (yes !== null)
        chain.set(
          ataAddress({ owner: agent.publicKey, mint: yesMint }),
          tokenInfo(yesMint, agent.publicKey, yes),
        )
      if (no !== null)
        chain.set(
          ataAddress({ owner: agent.publicKey, mint: noMint }),
          tokenInfo(noMint, agent.publicKey, no),
        )
      await insertTrades(h.db, [
        {
          sig: `t${n}`,
          ixIndex: 3,
          market: key.toBase58(),
          wallet,
          direction: 'usdcToYes',
          usdcAmount: 10n * M,
          usdcDelta: -10n * M,
          yesDelta: 15n * M,
          noDelta: 0n,
          fee: 0n,
          slot: 1n,
          blockTime: new Date((clock - 3_600) * 1000),
          botMemo: true,
        },
      ])
      return key
    }
    const won = await settled(2, 1, 15n * M, null)
    await settled(3, 2, 15n * M, null) // lost: no NO shares
    await settled(4, 1, null, 3n * M) // only NO shares of a YES market
    const a = agentWith()
    await a.round()
    expect(sender.specs.map((s) => s.label)).toEqual(['claim nba-2'])
    const ixs = sender.specs[0]?.instructions ?? []
    expect(ixs.some((ix) => ix.programId.equals(MEMO_PROGRAM_ID))).toBe(false)
    // The missing NO ATA is created first: claim_winnings takes both.
    expect(ixs).toHaveLength(2)
    expect([...(ixs[1]?.data.subarray(0, 8) ?? [])]).toEqual([
      ...PM_AMM_IX_DISCRIMINATORS.claimWinnings,
    ])
    expect(ixs[1]?.keys[1]?.pubkey.equals(won)).toBe(true)
    // Hourly, like the faucet.
    await a.round()
    expect(sender.specs).toHaveLength(1)
  })

  it('logs a claim in a dry run instead of sending it', async () => {
    const { key, fields, gameId } = await liveMarket(2)
    await setModel(gameId, 1, 'final')
    await updateMarket(h.db, key.toBase58(), { status: 'recycled' })
    chain.setMarket({ ...fields, resolved: true, winningSide: 1 })
    const yesMint = deriveYesMint(key)
    chain.set(
      ataAddress({ owner: agent.publicKey, mint: yesMint }),
      tokenInfo(yesMint, agent.publicKey, 4n * M),
    )
    await insertTrades(h.db, [
      {
        sig: 'dry',
        ixIndex: 3,
        market: key.toBase58(),
        wallet: agent.publicKey.toBase58(),
        direction: 'usdcToYes',
        usdcAmount: 1n,
        usdcDelta: -1n,
        yesDelta: 1n,
        noDelta: 0n,
        fee: 0n,
        slot: 1n,
        blockTime: new Date((clock - 3_600) * 1000),
        botMemo: true,
      },
    ])
    await agentWith({ dryRun: true }).round()
    expect(sender.specs).toEqual([])
    expect(logs.find((l) => l.msg === 'agent claim (dry run)')).toMatchObject({
      gameId: 'nba-2',
      winning: '4.00',
    })
  })

  it('counts a failed claim', async () => {
    const { key, fields, gameId } = await liveMarket(2)
    await setModel(gameId, 1, 'final')
    await updateMarket(h.db, key.toBase58(), { status: 'finalized' })
    chain.setMarket({ ...fields, resolved: true, winningSide: 1 })
    const yesMint = deriveYesMint(key)
    chain.set(
      ataAddress({ owner: agent.publicKey, mint: yesMint }),
      tokenInfo(yesMint, agent.publicKey, 4n * M),
    )
    await insertTrades(h.db, [
      {
        sig: 'c',
        ixIndex: 3,
        market: key.toBase58(),
        wallet: agent.publicKey.toBase58(),
        direction: 'usdcToYes',
        usdcAmount: 1n,
        usdcDelta: -1n,
        yesDelta: 1n,
        noDelta: 0n,
        fee: 0n,
        slot: 1n,
        blockTime: new Date((clock - 3_600) * 1000),
        botMemo: true,
      },
    ])
    sender.fail = new Error('boom')
    const report = await agentWith().round()
    expect(report.failures).toBe(1)
    expect(deriveMarketPda(2n).equals(key)).toBe(true)
  })
})
