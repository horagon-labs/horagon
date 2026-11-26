import { outcomeFor, quoteSwap, winProbability } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import { type AgentParams, defaultAgentParams } from '../src/agent/config'
import { type Decision, decide, type MarketView, sizeSwap } from '../src/agent/decide'
import { modelProbability } from '../src/tick'
import { lZeroFor, poolAt } from './agent-fixtures'

const NOW = 1_795_003_600
const M = 1_000_000n
const P = defaultAgentParams()

/** A live NBA winner market, 70 min to its end, priced 0.60 with the model at 0.70. */
function view(patch: Partial<MarketView> & { remaining?: number; seed?: number } = {}): MarketView {
  const { remaining = 4_200, seed = 300, ...rest } = patch
  const price = rest.price === undefined ? 0.6 : rest.price
  return {
    market: 'M1',
    gameId: 'nba-1',
    league: 'NBA',
    kind: 0,
    marketStatus: 'open',
    gameStatus: 'live',
    period: 3,
    clockSecs: 300,
    tipoff: NOW - 3_600,
    endTs: NOW + remaining,
    modelProb: 0.7,
    modelAt: NOW - 10,
    lastFanTradeAt: null,
    spent: 0n,
    swaps: 0,
    price,
    pool: price === null ? null : poolAt(price, { now: NOW, remaining, seed }),
    disabled: false,
    held: false,
    ...rest,
  }
}

const run = (v: MarketView, o: { balance?: bigint; params?: Partial<AgentParams> } = {}) =>
  decide(v, { now: NOW, balance: o.balance ?? 5_000n * M, params: { ...P, ...o.params } })

const reason = (d: Decision) => (d.action === 'skip' ? d.reason : 'swap')
const swapOf = (d: Decision) => {
  if (d.action !== 'swap') throw new Error(`expected a swap, got ${reason(d)}`)
  return d
}

describe('modelProb is the YES probability of a winner market', () => {
  it('is the home win probability, and YES is a home win', () => {
    // The keeper's model: margin is home minus away, p0 the pre-game home probability.
    const lead = { status: 'live', homeScore: 60, awayScore: 50, period: 3, clockSecs: 300 }
    const p = modelProbability({ ...lead } as never, 0.5, 13)
    expect(p).toBeGreaterThan(0.5)
    expect(p).toBe(winProbability({ margin: 10, minutesRemaining: 17, p0: 0.5, sigma: 13 }))
    // A winner market (kind 0) resolves YES when the home team wins.
    expect(outcomeFor(0, 101, 99, [])).toBe('yes')
    expect(outcomeFor(0, 99, 101, [])).toBe('no')
  })
})

describe('decide', () => {
  const cases: Array<
    [string, Partial<MarketView> & { remaining?: number }, string, Partial<AgentParams>?]
  > = [
    ['a live market with a gap', {}, 'swap'],
    ['disabled after an anomaly', { disabled: true }, 'disabled'],
    ['held while its anomaly check waits for the indexer', { held: true }, 'held'],
    ['disabled and held', { disabled: true, held: true }, 'disabled'],
    ['a second-half market', { kind: 1 }, 'kind'],
    ['another league', { league: 'NHL' }, 'league'],
    ['PRACTICE while AGENT_PRACTICE is off', { league: 'PRACTICE' }, 'league'],
    ['PRACTICE with AGENT_PRACTICE=1', { league: 'PRACTICE' }, 'swap', { practice: true }],
    ['halted', { marketStatus: 'halted' }, 'market-status'],
    ['proposed', { marketStatus: 'proposed' }, 'market-status'],
    ['challenged', { marketStatus: 'challenged' }, 'market-status'],
    ['finalized', { marketStatus: 'finalized' }, 'market-status'],
    ['a game still scheduled', { gameStatus: 'scheduled' }, 'not-live'],
    ['a final game', { gameStatus: 'final' }, 'not-live'],
    ['live before its scheduled tip-off', { tipoff: NOW + 60 }, 'not-live'],
    ['the horn of Q4: period 4 at 0 s, still live', { period: 4, clockSecs: 0 }, 'horn'],
    ['Q4 with 5 s left', { period: 4, clockSecs: 5 }, 'swap'],
    ['the end of Q3: period 3 at 0 s', { period: 3, clockSecs: 0 }, 'swap'],
    ['the horn of an overtime', { period: 5, clockSecs: 0 }, 'horn'],
    ['an overtime with 5 s left', { period: 5, clockSecs: 5 }, 'swap'],
    ['Q4 with no clock in the feed', { period: 4, clockSecs: null }, 'swap'],
    ['at tip-off', { tipoff: NOW }, 'swap'],
    ['120 s before end_ts', { remaining: 120 }, 'closing'],
    ['60 s before end_ts', { remaining: 60 }, 'closing'],
    ['121 s before end_ts', { remaining: 121 }, 'swap'],
    ['no model', { modelProb: null }, 'no-model'],
    ['a model out of [0, 1]', { modelProb: 1.2 }, 'no-model'],
    ['a model never dated', { modelAt: null }, 'stale-model'],
    ['a model 61 s old', { modelAt: NOW - 61 }, 'stale-model'],
    ['a model 60 s old', { modelAt: NOW - 60 }, 'swap'],
    ['a fan trade 30 s ago', { lastFanTradeAt: NOW - 30 }, 'fan-trade'],
    ['a fan trade 90 s ago', { lastFanTradeAt: NOW - 90 }, 'fan-trade'],
    ['a fan trade 91 s ago', { lastFanTradeAt: NOW - 91 }, 'swap'],
    ['a pool that cannot price', { price: null }, 'no-price'],
    ['a gap of +0.03', { modelProb: 0.63 }, 'in-band'],
    ['a gap of -0.03', { modelProb: 0.57 }, 'in-band'],
    ['a gap of -0.05', { modelProb: 0.55 }, 'swap'],
    ['40 swaps already', { swaps: 40 }, 'swap-count'],
    ['39 swaps', { swaps: 39 }, 'swap'],
    ['the game budget spent', { spent: 2_000n * M }, 'game-budget'],
    ['under 1 mUSDC of game budget left', { spent: 1_999_500_000n }, 'game-budget'],
    [
      'a landing size under AGENT_MIN_SWAP',
      {},
      'below-min',
      { minSwap: 60n * M, maxPerSwap: 100n * M },
    ],
  ]
  it.each(cases)('%s: %s', (_name, patch, expected, params) => {
    expect(reason(run(view(patch), { params: params ?? {} }))).toBe(expected)
  })

  it('skips with less than 1 mUSDC in the wallet', () => {
    expect(reason(run(view(), { balance: 999_999n }))).toBe('balance')
  })

  it('buys YES when the model is above the price, towards model - 0.02', () => {
    const d = swapOf(run(view()))
    expect(d).toMatchObject({ side: 'yes', direction: 'usdcToYes', price: 0.6, model: 0.7 })
    expect(d.gap).toBeCloseTo(0.1, 12)
    expect(d.target).toBeCloseTo(0.68, 12)
    expect(d.reachesTarget).toBe(true)
    expect(Math.abs(d.expectedPrice - 0.68)).toBeLessThanOrEqual(0.005)
    expect(d.expectedPrice).toBeLessThanOrEqual(0.68)
    expect(d.amountIn).toBeLessThan(100n * M)
  })

  it('buys NO when the model is below the price, towards model + 0.02', () => {
    const d = swapOf(run(view({ modelProb: 0.5 })))
    expect(d).toMatchObject({ side: 'no', direction: 'usdcToNo' })
    expect(d.gap).toBeCloseTo(-0.1, 12)
    expect(d.target).toBeCloseTo(0.52, 12)
    expect(Math.abs(d.expectedPrice - 0.52)).toBeLessThanOrEqual(0.005)
    expect(d.expectedPrice).toBeGreaterThanOrEqual(0.52)
  })

  it('quotes min_out at the configured slippage', () => {
    const v = view()
    const d = swapOf(run(v))
    const q = quoteSwap({
      pool: v.pool as never,
      direction: 'usdcToYes',
      amountIn: d.amountIn,
      now: NOW,
      slippageBps: 200,
    })
    expect(d.minOut).toBe(q.minOut)
    expect(d.minOut).toBe((q.amountOut * 9_800n) / 10_000n)
  })

  describe('caps', () => {
    // A 1,000 mUSDC pool at 0.40 with the model at 0.95: the target is far beyond one swap.
    const far = (patch: Partial<MarketView> = {}) =>
      view({ seed: 1_000, price: 0.4, modelProb: 0.95, ...patch })

    it('stops at AGENT_MAX_PER_SWAP (100 mUSDC): a partial move', () => {
      const d = swapOf(run(far()))
      expect(d.amountIn).toBe(100n * M)
      expect(d.reachesTarget).toBe(false)
      expect(d.expectedPrice).toBeGreaterThan(0.4)
      expect(d.expectedPrice).toBeLessThan(d.target - 0.005)
    })

    it('stops at what is left of the game budget', () => {
      expect(swapOf(run(far({ spent: 1_970n * M }))).amountIn).toBe(30n * M)
    })

    it('stops at the wallet balance', () => {
      expect(swapOf(run(far(), { balance: 12n * M })).amountIn).toBe(12n * M)
    })

    it('takes the smallest of the three', () => {
      expect(swapOf(run(far({ spent: 1_950n * M }), { balance: 40n * M })).amountIn).toBe(40n * M)
      expect(swapOf(run(far({ spent: 1_990n * M }), { balance: 40n * M })).amountIn).toBe(10n * M)
    })
  })
})

describe('sizeSwap', () => {
  const GRID: Array<{ seed: number; remaining: number }> = [
    { seed: 300, remaining: 7_200 },
    { seed: 300, remaining: 1_200 },
    { seed: 1_000, remaining: 4_200 },
    { seed: 1_000, remaining: 300 },
    { seed: 5_000, remaining: 9_000 },
  ]
  const MOVES: Array<[number, number, 'usdcToYes' | 'usdcToNo']> = [
    [0.5, 0.58, 'usdcToYes'],
    [0.3, 0.42, 'usdcToYes'],
    [0.8, 0.93, 'usdcToYes'],
    [0.6, 0.48, 'usdcToNo'],
    [0.15, 0.07, 'usdcToNo'],
  ]

  it('lands within 0.005 of the target for several L and time-left values', () => {
    for (const { seed, remaining } of GRID) {
      for (const [price, target, direction] of MOVES) {
        const pool = poolAt(price, { now: NOW, remaining, lZero: lZeroFor(seed, 0.6) })
        const size = sizeSwap({
          pool,
          direction,
          target,
          cap: 1_000_000n * M,
          now: NOW,
          tolerance: 0.005,
        })
        const label = `${seed}/${remaining}: ${price} -> ${target}`
        expect(size, label).not.toBeNull()
        if (!size) continue
        expect(size.reachesTarget, label).toBe(true)
        expect(Math.abs(size.priceAfter - target), label).toBeLessThanOrEqual(0.005)
        // The quote of the returned amount is the price the agent expects.
        const q = quoteSwap({ pool, direction, amountIn: size.amountIn, now: NOW })
        expect(q.priceAfter, label).toBe(size.priceAfter)
        // One raw unit more passes the target.
        const next = quoteSwap({ pool, direction, amountIn: size.amountIn + 1n, now: NOW })
        expect(Math.sign(target - next.priceAfter), label).toBe(direction === 'usdcToYes' ? -1 : 1)
      }
    }
  })

  it('uses the time left: the same amount moves a pool more near its end', () => {
    const lZero = lZeroFor(1_000, 0.6)
    const early = poolAt(0.5, { now: NOW, remaining: 7_200, lZero })
    const late = poolAt(0.5, { now: NOW, remaining: 600, lZero })
    const at = (pool: typeof early) =>
      sizeSwap({
        pool,
        direction: 'usdcToYes',
        target: 0.58,
        cap: 100_000n * M,
        now: NOW,
        tolerance: 0.005,
      })
    expect((at(late)?.amountIn ?? 0n) < (at(early)?.amountIn ?? 0n)).toBe(true)
  })

  it('respects the cap', () => {
    const pool = poolAt(0.5, { now: NOW, lZero: lZeroFor(1_000, 0.6) })
    const uncapped = sizeSwap({
      pool,
      direction: 'usdcToYes',
      target: 0.58,
      cap: 100_000n * M,
      now: NOW,
      tolerance: 0.005,
    })
    expect(uncapped && uncapped.amountIn > 100n * M).toBe(true)
    const capped = sizeSwap({
      pool,
      direction: 'usdcToYes',
      target: 0.58,
      cap: 100n * M,
      now: NOW,
      tolerance: 0.005,
    })
    expect(capped?.amountIn).toBe(100n * M)
    expect(capped?.reachesTarget).toBe(false)
    expect(capped?.priceAfter).toBe(
      quoteSwap({ pool, direction: 'usdcToYes', amountIn: 100n * M, now: NOW }).priceAfter,
    )
  })

  it('sends the cap as a partial move when the cap cannot reach the target (ruling 2026-11-26)', () => {
    // The brief's case: a pool at 0.62 while the model says 0.99, and the reverse.
    const cases: Array<[number, number, 'usdcToYes' | 'usdcToNo', number]> = [
      [0.62, 0.97, 'usdcToYes', 1_000],
      [0.62, 0.97, 'usdcToYes', 300],
      [0.8, 0.12, 'usdcToNo', 1_000],
    ]
    for (const [price, target, direction, seed] of cases) {
      const pool = poolAt(price, { now: NOW, lZero: lZeroFor(seed, 0.6) })
      for (const cap of [1n * M, 25n * M, 100n * M]) {
        const label = `${seed}: ${price} -> ${target}, cap ${cap}`
        const size = sizeSwap({ pool, direction, target, cap, now: NOW, tolerance: 0.005 })
        expect(size, label).not.toBeNull()
        expect(size?.reachesTarget, label).toBe(false)
        expect(size?.amountIn, label).toBe(cap)
        // It moves the price toward the target, and stops short of it.
        const moved = (size?.priceAfter ?? price) - price
        expect(Math.sign(moved), label).toBe(direction === 'usdcToYes' ? 1 : -1)
        expect(Math.abs((size?.priceAfter ?? 0) - target), label).toBeGreaterThan(0.005)
      }
    }
  })

  it('returns null when no amount moves the price toward the target', () => {
    const pool = poolAt(0.5, { now: NOW })
    const base = { pool, direction: 'usdcToYes' as const, now: NOW, tolerance: 0.005 }
    // No cap left.
    expect(sizeSwap({ ...base, target: 0.58, cap: 0n })).toBeNull()
    // A YES buy only raises the price: a target below it is out of reach at any size.
    expect(sizeSwap({ ...base, target: 0.45, cap: 100n * M })).toBeNull()
    expect(sizeSwap({ ...base, direction: 'usdcToNo', target: 0.55, cap: 100n * M })).toBeNull()
    // A pool that cannot fill any amount (no liquidity).
    expect(
      sizeSwap({ ...base, pool: { ...pool, hasLiquidity: false }, target: 0.58, cap: 100n * M }),
    ).toBeNull()
  })
})
