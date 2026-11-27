import { Writable } from 'node:stream'
import { type DbHandle, getHeartbeat, insertTrades, updateMarket } from '@horagon/db'
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
  PROTOCOL_DAO,
  SWAP_COMPUTE_UNITS,
} from '@horagon/sdk'
import { Keypair, type PublicKey } from '@solana/web3.js'
import pino from 'pino'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type AgentDeps,
  ANOMALY_HELD_MSG,
  DRY_LOW_MUSDC_MSG,
  ReferenceAgent,
  SLOW_READS_MSG,
} from '../src/agent/agent'
import { type AgentParams, defaultAgentParams } from '../src/agent/config'
import type { Decision } from '../src/agent/decide'
import { ANOMALY_HOLD_SECS } from '../src/agent/guards'
import { ProgramFailure, UnresolvedAttempt } from '../src/executor'
import {
  FakeChain,
  FakeSender,
  type MarketFields,
  poolAt,
  type SeededMarket,
  seedLiveMarket,
  tokenInfo,
  writeModel,
} from './agent-fixtures'

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
/** Seconds a faucet claim takes (the fake clock moves on by that much). */
let faucetSecs: number

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
  faucetSecs = 0
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
      clock += faucetSecs
      if (faucetError) throw faucetError
    },
    priorityMicroLamports: 10_000,
  }
  return new ReferenceAgent(deps)
}

/** A live NBA game with its open winner market (id `n`), and the market on the fake chain. */
function liveMarket(
  n: number,
  o: { price?: number; model?: number; seed?: number; league?: string } = {},
): Promise<SeededMarket> {
  return seedLiveMarket(h.db, chain, n, { now: NOW, modelAt: clock - 5, ...o })
}

/** The keeper's tick writing a fresh model for the game, as of `clock`. */
function setModel(gameId: string, modelProb: number, status = 'live'): Promise<void> {
  return writeModel(h.db, gameId, modelProb, clock - 5, status)
}

/** Moves the fake market's YES price, as a swap would. */
function movePrice(fields: MarketFields, price: number): void {
  chain.setMarket({
    ...fields,
    pool: poolAt(price, { now: NOW, remaining: 4_200, lZero: fields.pool.lZero }),
  })
}

const reasons = (ds: Decision[]) => ds.map((d) => (d.action === 'skip' ? d.reason : 'swap'))
const sizesOf = (ds: Decision[]) => ds.map((d) => (d.action === 'swap' ? d.amountIn : 0n))
const keys = () => alerts.map(([k]) => k)
/** The `agent` row of keeper_heartbeats. */
const agentRow = async () => (await getHeartbeat(h.db, 'agent'))?.info

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
    // 5,000 mUSDC is more than the spend cap of 2 markets (2 x 2,000): the real balance.
    expect(swap).not.toHaveProperty('notional')
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

  it('plans against its spend cap from an empty wallet: sized swaps, nothing sent, no page', async () => {
    // The agent wallet before its first faucet claim: no mUSDC account at all.
    chain.musdc = null
    await liveMarket(1, { seed: 1_000, price: 0.4, model: 0.95 })
    await liveMarket(2, { seed: 1_000, price: 0.4, model: 0.95 })
    await liveMarket(3, { price: 0.6, model: 0.62 })
    const a = agentWith({ dryRun: true })
    const report = await a.round()
    const byGame = Object.fromEntries(report.decisions.map((d) => [d.gameId, reasons([d])[0]]))
    expect(byGame).toEqual({ 'nba-1': 'swap', 'nba-2': 'swap', 'nba-3': 'in-band' })
    // Sized as a funded live run would size them: the per-swap cap, as the pools are far off.
    expect(sizesOf(report.decisions).sort()).toEqual([0n, 100n * M, 100n * M])
    expect(sender.specs).toEqual([])
    expect(faucetCalls).toEqual([])
    expect(alerts).toEqual([])
    const swaps = logs.filter((l) => l.msg === 'agent swap')
    expect(swaps).toHaveLength(2)
    for (const swap of swaps) {
      expect(swap).toMatchObject({ dryRun: true, notional: true, size: '100.00', level: 30 })
    }
    expect(logs.find((l) => l.msg === 'agent skip')).toMatchObject({
      gameId: 'nba-3',
      reason: 'in-band',
      notional: true,
    })
    // The low wallet goes to the log instead, at most hourly, and says it is a dry run.
    const low = () => logs.filter((l) => l.msg === DRY_LOW_MUSDC_MSG)
    expect(DRY_LOW_MUSDC_MSG).toContain('dry run')
    expect(low()).toHaveLength(1)
    expect(low()[0]).toMatchObject({ musdc: '0.00', minMusdc: '200.00', dryRun: true })
    clock += 3_599
    await a.round()
    expect(low()).toHaveLength(1)
    clock += 1
    await a.round()
    expect(low()).toHaveLength(2)
    expect(alerts).toEqual([])
    expect(faucetCalls).toEqual([])
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
    for (const owner of [program.authority, PROTOCOL_DAO]) {
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
    expect(sizesOf(report.decisions)).toEqual([100n * M, 20n * M])
    expect(sender.specs.map((s) => s.label).sort()).toEqual(['swap nba-1', 'swap nba-2'])
  })

  it('never plans more than the balance in one round: unknown and refused sends count too', async () => {
    for (const n of [1, 2, 3]) await liveMarket(n, { seed: 1_000, price: 0.4, model: 0.95 })
    chain.musdc = 150n * M
    // A dry run holding less than its spend cap (3 x 2,000 mUSDC) plans against the cap, and
    // sends nothing.
    const dry = await agentWith({ dryRun: true }).round()
    expect(sizesOf(dry.decisions)).toEqual([100n * M, 100n * M, 100n * M])
    expect(sender.specs).toEqual([])
    // A send whose result is unknown may still land: its amount is gone for the round.
    sender.fail = new UnresolvedAttempt('swap nba-1: unresolved after 90 s')
    const live = await agentWith().round()
    expect(sizesOf(live.decisions)).toEqual([100n * M, 50n * M, 0n])
    expect(reasons(live.decisions)).toEqual(['swap', 'swap', 'balance'])
    const planned = live.decisions.reduce(
      (sum, d) => sum + (d.action === 'swap' ? d.amountIn : 0n),
      0n,
    )
    expect(planned <= 150n * M).toBe(true)
    // A swap the program refused moved nothing, yet the round still counts it: the next round
    // reads the real balance.
    sender.fail = new ProgramFailure('swap nba-1', 'pm-AMM', 6001, 'SlippageExceeded', [])
    const refused = await agentWith().round()
    expect(sizesOf(refused.decisions)).toEqual([100n * M, 50n * M, 0n])
    expect(reasons(refused.decisions)).toEqual(['swap', 'swap', 'balance'])
    expect(refused.failures).toBe(2)
  })

  it('ends the round when a slow send left its snapshot old, and trades the rest on the next', async () => {
    const markets = [await liveMarket(1), await liveMarket(2)]
    const fieldsOf = new Map(markets.map((m) => [`swap ${m.gameId}`, m.fields]))
    // The first send takes 90 s (a dropped attempt, then the sender's wait for it); each landed
    // swap moves its market to the target.
    sender.onSend = (spec) => {
      if (sender.specs.length === 1) clock += 90
      const fields = fieldsOf.get(spec.label)
      if (fields) movePrice(fields, 0.68)
    }
    const a = agentWith()
    const first = await a.round()
    expect(first.sent).toBe(1)
    expect(first.decisions).toHaveLength(1)
    expect(first.cut).toBe('stale')
    expect(logs.find((l) => l.msg === 'agent round cut short')).toMatchObject({
      reason: 'stale',
      ageSecs: 90,
      left: 1,
    })
    const [sentFirst] = sender.specs.map((s) => s.label)
    const other = sentFirst === 'swap nba-1' ? 'swap nba-2' : 'swap nba-1'
    // Meanwhile the keeper's tick wrote the model again: the next round reads everything anew
    // and trades the market the first one left.
    for (const m of markets) await setModel(m.gameId, 0.7)
    const second = await a.round()
    expect(second.cut).toBeNull()
    // It starts with the market the first round left.
    expect(reasons(second.decisions)).toEqual(['swap', 'in-band'])
    expect(sender.specs.map((s) => s.label)).toEqual([sentFirst, other])
  })

  it('starts each round at the market after the last one decided, so a cut leaves none behind', async () => {
    const markets = [await liveMarket(1), await liveMarket(2), await liveMarket(3)]
    // Every send takes 90 s: each round decides one market, swaps it and is cut.
    sender.onSend = () => {
      clock += 90
    }
    const a = agentWith()
    const decided: string[] = []
    for (let round = 1; round <= 4; round++) {
      // The keeper's tick keeps the model fresh meanwhile.
      for (const m of markets) await setModel(m.gameId, 0.7)
      const report = await a.round()
      expect(report.cut, `round ${round}`).toBe('stale')
      expect(reasons(report.decisions), `round ${round}`).toEqual(['swap'])
      decided.push(report.decisions[0]?.gameId ?? '')
    }
    // Every market is decided within 3 rounds, and the fourth wraps around to the first.
    expect(decided.slice(0, 3).sort()).toEqual(['nba-1', 'nba-2', 'nba-3'])
    expect(decided[3]).toBe(decided[0])
    expect(sender.specs.map((s) => s.label)).toEqual(decided.map((g) => `swap ${g}`))
  })

  it('decides on the clock read after the hourly faucet and claims, not before', async () => {
    await liveMarket(1)
    // The faucet answers after 90 s: the model the keeper wrote 5 s before the round began is
    // 95 s old by then, too old to trade on.
    faucetSecs = 90
    const report = await agentWith().round()
    expect(reasons(report.decisions)).toEqual(['stale-model'])
    expect(sender.specs).toEqual([])
  })

  it('sends nothing new once the stop signal comes, and ends the round', async () => {
    for (const n of [1, 2, 3]) await liveMarket(n)
    const stop = new AbortController()
    // The signal comes while the first swap is in flight: that send completes, no other starts.
    sender.onSend = () => stop.abort()
    const report = await agentWith().round(stop.signal)
    expect(sender.specs).toHaveLength(1)
    expect(report.sent).toBe(1)
    expect(report.cut).toBe('stop')
    expect(logs.find((l) => l.msg === 'agent round cut short')).toMatchObject({
      reason: 'stop',
      left: 2,
    })
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

  it('skips a game at the horn: Q4 or overtime at 0 s, while the feed still says live', async () => {
    const { gameId } = await liveMarket(1)
    // The buzzer frame: the model reads 1, the result is known, and the market is still open.
    await writeModel(h.db, gameId, 1, clock - 5, 'live', { period: 4, clockSecs: 0 })
    expect(reasons((await agentWith({ dryRun: true }).round()).decisions)).toEqual(['horn'])
    await writeModel(h.db, gameId, 1, clock - 5, 'live', { period: 5, clockSecs: 0 })
    expect(reasons((await agentWith({ dryRun: true }).round()).decisions)).toEqual(['horn'])
    // 5 s left in Q4, or the end of Q3: it trades.
    await writeModel(h.db, gameId, 0.7, clock - 5, 'live', { period: 4, clockSecs: 5 })
    expect(reasons((await agentWith({ dryRun: true }).round()).decisions)).toEqual(['swap'])
    await writeModel(h.db, gameId, 0.7, clock - 5, 'live', { period: 3, clockSecs: 0 })
    expect(reasons((await agentWith({ dryRun: true }).round()).decisions)).toEqual(['swap'])
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
    expect(await agentRow()).toEqual({
      round: 1,
      dryRun: true,
      // Whether it trades PRACTICE markets too (AGENT_PRACTICE): the Practice page reads it (R8).
      practice: false,
      paused: false,
      markets: 1,
      decided: 1,
      cut: null,
      sent: 0,
      disabled: [],
    })
  })

  it('writes the cut in its heartbeat, and warns at most every 10 min while slow reads cut every round', async () => {
    const { gameId } = await liveMarket(1)
    const a = agentWith({ dryRun: true })
    const warnings = () => logs.filter((l) => l.msg === SLOW_READS_MSG)
    // A degraded RPC: every chain read takes 15 s, so the snapshot is older than half an
    // interval (10 s) before the first decision.
    chain.onRead = () => {
      clock += 15
    }
    const first = await a.round()
    expect(first.cut).toBe('stale')
    expect(first.decisions).toEqual([])
    expect(await agentRow()).toMatchObject({ markets: 1, decided: 0, cut: 'stale', sent: 0 })
    await a.round()
    expect(warnings()).toEqual([])
    // The third round in a row cut before its first decision.
    await a.round()
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toMatchObject({ level: 40, rounds: 3, freshSecs: 10, markets: 1 })
    const warnedAt = clock
    // Still slow: no other warning for 10 min.
    clock = warnedAt + 584
    await a.round()
    expect(clock).toBe(warnedAt + 599)
    expect(warnings()).toHaveLength(1)
    await a.round()
    expect(warnings()).toHaveLength(2)
    expect(warnings()[1]).toMatchObject({ rounds: 5 })
    // The RPC answers fast again: a round that decides ends the streak.
    chain.onRead = null
    await setModel(gameId, 0.7)
    const fast = await a.round()
    expect(fast.cut).toBeNull()
    expect(reasons(fast.decisions)).toEqual(['swap'])
    expect(await agentRow()).toMatchObject({ markets: 1, decided: 1, cut: null })
    // Slow again 10 min later: the count starts over, and the third round warns.
    clock += 600
    chain.onRead = () => {
      clock += 15
    }
    await a.round()
    await a.round()
    expect(warnings()).toHaveLength(2)
    await a.round()
    expect(warnings()).toHaveLength(3)
    expect(warnings()[2]).toMatchObject({ rounds: 3 })
  })
})

describe('the anomaly check', () => {
  /** A swap by another wallet on `market`, with its block time `at` (Unix seconds). */
  const otherTrade = (market: PublicKey, at: number, sig: string) => ({
    sig,
    ixIndex: 3,
    market: market.toBase58(),
    wallet: 'OTHER',
    direction: 'usdcToNo',
    usdcAmount: 150n * M,
    usdcDelta: -150n * M,
    yesDelta: 0n,
    noDelta: 200n * M,
    fee: 0n,
    slot: 1n,
    blockTime: new Date(at * 1000),
    botMemo: false,
  })

  it('clears the check when another wallet traded after the swap: no disable, no page', async () => {
    const { key, fields, gameId } = await liveMarket(1)
    // The agent buys YES; before its next read another wallet buys NO and pushes the price
    // below where it was. That is someone else's move: one counter-trade must not switch the
    // agent off the market.
    sender.onSend = () => movePrice(fields, 0.55)
    const a = agentWith()
    expect(reasons((await a.round()).decisions)).toEqual(['swap'])
    await insertTrades(h.db, [otherTrade(key, NOW + 5, 'counter')])
    clock = NOW + 20
    await setModel(gameId, 0.7)
    // It steps aside for that trade (the fan lag), and nothing is disabled or paged.
    expect(reasons((await a.round()).decisions)).toEqual(['fan-trade'])
    expect(keys()).toEqual([])
    expect(logs.find((l) => l.msg.includes('check cleared'))).toMatchObject({
      market: key.toBase58(),
      tradeAt: NOW + 5,
    })
    expect(await agentRow()).toMatchObject({ disabled: [] })
    // Once that trade is over 90 s old, it trades the market again.
    sender.onSend = null
    clock = NOW + 5 + 91
    await setModel(gameId, 0.7)
    expect(reasons((await a.round()).decisions)).toEqual(['swap'])
    expect(keys()).toEqual([])
  })

  it('clears it for a trade after the swap even when the next read comes late', async () => {
    const { key, fields, gameId } = await liveMarket(1)
    sender.onSend = () => movePrice(fields, 0.55)
    const a = agentWith()
    await a.round()
    // The other wallet traded 10 s after the swap, and the next read comes 200 s after it (a
    // slow round, a pause): outside the 90 s fan-lag window by then, still after the swap.
    await insertTrades(h.db, [otherTrade(key, NOW + 10, 'counter')])
    sender.onSend = null
    clock = NOW + 200
    await setModel(gameId, 0.7)
    expect(reasons((await a.round()).decisions)).toEqual(['swap'])
    expect(keys()).toEqual([])
  })

  it('holds a market whose counter-trade the indexer stores late, then clears it: no disable, no page', async () => {
    const { key, fields, gameId } = await liveMarket(1)
    const a = agentWith()
    expect(reasons((await a.round()).decisions)).toEqual(['swap'])
    // Another wallet buys NO 15 s after the swap and pushes the price below where it was. The
    // indexer, behind a keeper send, has not stored that trade by the next read.
    movePrice(fields, 0.55)
    clock = NOW + 20
    await setModel(gameId, 0.7)
    expect(reasons((await a.round()).decisions)).toEqual(['held'])
    expect(keys()).toEqual([])
    expect(sender.specs).toHaveLength(1)
    expect(logs.find((l) => l.msg === ANOMALY_HELD_MSG)).toMatchObject({
      market: key.toBase58(),
      level: 40,
      until: NOW + 20 + ANOMALY_HOLD_SECS,
    })
    // Stored after that read: the next one clears the check and steps aside for the trade.
    await insertTrades(h.db, [otherTrade(key, NOW + 15, 'late')])
    clock = NOW + 40
    await setModel(gameId, 0.7)
    expect(reasons((await a.round()).decisions)).toEqual(['fan-trade'])
    expect(logs.find((l) => l.msg.includes('check cleared'))).toMatchObject({ tradeAt: NOW + 15 })
    expect(await agentRow()).toMatchObject({ disabled: [] })
    // Past the end the hold would have had: still enabled, and trading once the fan lag passed.
    clock = NOW + 20 + ANOMALY_HOLD_SECS
    await setModel(gameId, 0.7)
    expect(reasons((await a.round()).decisions)).toEqual(['swap'])
    expect(keys()).toEqual([])
  })

  it('still disables on a wrong-way move when the only other trade came before the swap', async () => {
    const { key, fields, gameId } = await liveMarket(1)
    // Another wallet traded 95 s before the round: outside the fan lag, so the agent swaps.
    await insertTrades(h.db, [otherTrade(key, NOW - 95, 'before')])
    sender.onSend = () => movePrice(fields, 0.55)
    const a = agentWith()
    expect(reasons((await a.round()).decisions)).toEqual(['swap'])
    // Held while the indexer may still store a trade after the swap; none comes.
    for (const at of [20, 40, 19 + ANOMALY_HOLD_SECS]) {
      clock = NOW + at
      await setModel(gameId, 0.7)
      expect(reasons((await a.round()).decisions), String(at)).toEqual(['held'])
      expect(keys()).toEqual([])
    }
    clock = NOW + 20 + ANOMALY_HOLD_SECS
    await setModel(gameId, 0.7)
    expect(reasons((await a.round()).decisions)).toEqual(['disabled'])
    expect(keys()).toEqual(['agent-anomaly:nba-1'])
    expect(sender.specs).toHaveLength(1)
  })

  it('disables a market whose price moved away from the model after the swap', async () => {
    const { key, fields, gameId } = await liveMarket(1)
    sender.onSend = () => movePrice(fields, 0.55)
    const a = agentWith()
    await a.round()
    expect(reasons((await a.round()).decisions)).toEqual(['held'])
    clock = NOW + ANOMALY_HOLD_SECS
    const third = await a.round()
    expect(reasons(third.decisions)).toEqual(['disabled'])
    expect(keys()).toEqual(['agent-anomaly:nba-1'])
    expect(alerts[0]?.[1]).toContain(
      'no trade by another wallet showed within 2 min; market disabled until the agent is restarted by hand',
    )
    expect(logs.find((l) => l.msg === 'agent anomaly')).toMatchObject({
      market: key.toBase58(),
      priceBefore: expect.any(Number),
    })
    // Still disabled, and alerted once.
    expect(reasons((await a.round()).decisions)).toEqual(['disabled'])
    expect(keys()).toEqual(['agent-anomaly:nba-1'])
    expect(sender.specs).toHaveLength(1)
    // A new process that does not resume the last run (as one started by hand after a clean
    // stop) trades it again.
    await setModel(gameId, 0.7)
    expect(reasons((await agentWith().round()).decisions)).toEqual(['swap'])
  })

  it('keeps a market disabled across an unplanned restart, not across a stop by hand', async () => {
    const { key, fields, gameId } = await liveMarket(1)
    sender.onSend = () => movePrice(fields, 0.55)
    const a = agentWith()
    await a.round()
    expect(reasons((await a.round()).decisions)).toEqual(['held'])
    clock = NOW + ANOMALY_HOLD_SECS
    expect(reasons((await a.round()).decisions)).toEqual(['disabled'])
    // A crash or a stall exit: no clean stop, and systemd starts a new process.
    const b = agentWith()
    expect(await b.resume()).toEqual([key.toBase58()])
    expect(logs.find((l) => l.msg.includes('stay disabled'))).toMatchObject({
      markets: [key.toBase58()],
      level: 40,
    })
    expect(reasons((await b.round()).decisions)).toEqual(['disabled'])
    // Stopped by hand (SIGTERM): the last heartbeat says so, and the next process starts clean.
    await b.stop()
    expect((await getHeartbeat(h.db, 'agent'))?.info).toMatchObject({
      stopped: true,
      disabled: [key.toBase58()],
    })
    const c = agentWith()
    expect(await c.resume()).toEqual([])
    await setModel(gameId, 0.7)
    expect(reasons((await c.round()).decisions)).toEqual(['swap'])
    // Its rounds write no `stopped`: an exit from here on is unplanned again.
    expect((await getHeartbeat(h.db, 'agent'))?.info).not.toHaveProperty('stopped')
  })

  it('checks a swap whose result was unknown as well, once it shows on the chain', async () => {
    const { fields } = await liveMarket(1)
    sender.fail = new UnresolvedAttempt('swap nba-1: unresolved after 90 s')
    const a = agentWith()
    expect((await a.round()).failures).toBe(1)
    // It landed after all, and the price moved away from the model.
    movePrice(fields, 0.55)
    sender.fail = null
    expect(reasons((await a.round()).decisions)).toEqual(['held'])
    clock = NOW + ANOMALY_HOLD_SECS
    expect(reasons((await a.round()).decisions)).toEqual(['disabled'])
    expect(keys()).toEqual(['agent-anomaly:nba-1'])
  })

  it('takes a read that shows no move after an unknown send as no proof either way', async () => {
    await liveMarket(1)
    sender.fail = new UnresolvedAttempt('swap nba-1: unresolved after 90 s')
    const a = agentWith()
    await a.round()
    sender.fail = null
    expect(reasons((await a.round()).decisions)).toEqual(['swap'])
    expect(keys()).toEqual([])
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

  it('starts a pause when the failure is seen: after a 90 s send it lasts the full 10 min', async () => {
    await liveMarket(1)
    await liveMarket(2)
    // One failure pauses. The first send gives up after 90 s, its result unknown.
    sender.onAttempt = () => {
      clock += 90
    }
    sender.fail = new UnresolvedAttempt('swap nba-1: unresolved after 90 s')
    const a = agentWith({ params: { maxFailures: 1 } })
    const report = await a.round()
    expect(report.failures).toBe(1)
    expect(keys()).toEqual(['agent-paused'])
    // The pause runs from the failure, 90 s after the round's read.
    expect(a.failures.pausedUntil).toBe(NOW + 90 + 600)
    // It ends the round before the other market.
    expect(report.cut).toBe('pause')
    expect(report.decisions).toHaveLength(1)
    expect(await agentRow()).toMatchObject({
      paused: true,
      pausedUntil: NOW + 690,
      cut: 'pause',
      markets: 2,
      decided: 1,
    })
    sender.fail = null
    sender.onAttempt = null
    clock = NOW + 90 + 599
    expect((await a.round()).paused).toBe(true)
    clock = NOW + 90 + 600
    const after = await a.round()
    expect(after.paused).toBe(false)
    expect(after.markets).toBe(2)
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
  it('pages when the wallet runs low on SOL or mUSDC; a dry run pages SOL only', async () => {
    await liveMarket(1)
    chain.lamports = 50_000_000
    chain.musdc = 150n * M
    await agentWith().round()
    expect(keys()).toEqual(['agent-sol', 'agent-musdc'])
    expect(alerts[0]?.[1]).toContain('0.05 SOL')
    expect(alerts[1]?.[1]).toContain('150.00 mUSDC, under 200.00')
    alerts = []
    await agentWith({ dryRun: true }).round()
    expect(keys()).toEqual(['agent-sol'])
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

  /**
   * A finalized market `n` the agent traded, resolved on the chain to `winningSide`, with the
   * agent's YES and NO balances there (null: no account).
   */
  const settled = async (n: number, winningSide: number, yes: bigint | null, no: bigint | null) => {
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
        wallet: agent.publicKey.toBase58(),
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

  it('claims settled markets where it holds winning shares, without a memo', async () => {
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

  it('sends no claim after the stop signal, and no swap after that', async () => {
    await settled(2, 1, 15n * M, null)
    await settled(3, 1, 15n * M, null)
    await liveMarket(4)
    const stop = new AbortController()
    // The signal comes while the first claim is in flight: that send completes, no other starts.
    sender.onSend = () => stop.abort()
    const report = await agentWith().round(stop.signal)
    expect(sender.specs.map((s) => s.label)).toEqual([expect.stringMatching(/^claim nba-[23]$/)])
    // The live market is read, then the round ends before its first decision.
    expect(report.cut).toBe('stop')
    expect(report.markets).toBe(1)
    expect(report.decisions).toEqual([])
    expect(report.sent).toBe(0)
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
