import { readFileSync } from 'node:fs'
import type { TradeRow } from '@horagon/db'
import { GameActivitySchema, REFERENCE_AGENT_WALLET } from '@horagon/sdk'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  BOT_RATE as COUNT_FANS_BOT_RATE,
  isRateBot as countFansIsRateBot,
} from '../../../scripts/count-fans.mjs'
import { BOT_RATE, gameActivity, isRateBot, TEAM_WALLETS } from '../src/activity'

const AGENT = REFERENCE_AGENT_WALLET
/** The other team-burner of docs/metrics-wallets.json. */
const TEAM = '9v2ZmruntFtM4HmUFNq3Nn3rpXhV3uh8FmyRWafVbcHN'
const T0 = 1_795_000_000

let seq = 0
/** One swap row; `secs` after T0, `usdc` in raw mUSDC (6 decimals). */
function row(
  wallet: string,
  over: { secs?: number; usdc?: bigint; botMemo?: boolean | null; direction?: string } = {},
): TradeRow {
  const usdc = over.usdc ?? 1_000_000n
  return {
    sig: `sig${seq++}`,
    ixIndex: 2,
    market: 'MarketOfTheGame',
    wallet,
    direction: over.direction ?? 'usdcToYes',
    usdcAmount: usdc,
    usdcDelta: -usdc,
    yesDelta: usdc,
    noDelta: 0n,
    fee: 0n,
    slot: 1n,
    blockTime: new Date((T0 + (over.secs ?? 0)) * 1000),
    botMemo: over.botMemo === undefined ? false : over.botMemo,
  }
}

/** `n` swaps of one wallet, `gap` seconds apart. */
const burst = (wallet: string, n: number, gap: number) =>
  Array.from({ length: n }, (_, i) => row(wallet, { secs: i * gap }))

const zero = { swaps: 0, wallets: 0, volumeUsdc: '0' }

describe('gameActivity (R2b)', () => {
  it.each([
    {
      name: 'no trades: zeros and nulls',
      rows: [],
      memo: [],
      agent: zero,
      fans: zero,
      others: zero,
      lastAgent: null,
      lastFan: null,
    },
    {
      name: 'the agent only',
      rows: [row(AGENT, { secs: 5 }), row(AGENT, { secs: 95, usdc: 2_500_000n })],
      memo: [AGENT],
      agent: { swaps: 2, wallets: 1, volumeUsdc: '3.5' },
      fans: zero,
      others: zero,
      lastAgent: T0 + 95,
      lastFan: null,
    },
    {
      name: 'fans only',
      rows: [row('FanA', { secs: 10 }), row('FanB', { secs: 40 }), row('FanA', { secs: 20 })],
      memo: [],
      agent: zero,
      fans: { swaps: 3, wallets: 2, volumeUsdc: '3' },
      others: zero,
      lastAgent: null,
      lastFan: T0 + 40,
    },
    {
      name: 'a mix: agent, fans, a team wallet, a memo bot and a rate bot',
      rows: [
        row(AGENT, { secs: 300 }),
        row('FanA', { secs: 200, usdc: 4_000_000n }),
        row('FanB', { secs: 100 }),
        row(TEAM, { secs: 400 }),
        row('MemoBot', { secs: 500, botMemo: true }),
        ...burst('RateBot', 20, 15),
      ],
      memo: [AGENT, 'MemoBot'],
      agent: { swaps: 1, wallets: 1, volumeUsdc: '1' },
      fans: { swaps: 2, wallets: 2, volumeUsdc: '5' },
      others: { swaps: 22, wallets: 3, volumeUsdc: '22' },
      lastAgent: T0 + 300,
      lastFan: T0 + 200,
    },
    {
      name: 'a null memo counts as false: the wallet is a fan',
      rows: [row('FanA', { botMemo: null }), row('FanA', { secs: 1, botMemo: null })],
      memo: [],
      agent: zero,
      fans: { swaps: 2, wallets: 1, volumeUsdc: '2' },
      others: zero,
      lastAgent: null,
      lastFan: T0 + 1,
    },
    {
      name: 'a memo swap on another market makes the wallet a bot here',
      rows: [row('Elsewhere', { botMemo: false })],
      memo: ['Elsewhere'],
      agent: zero,
      fans: zero,
      others: { swaps: 1, wallets: 1, volumeUsdc: '1' },
      lastAgent: null,
      lastFan: null,
    },
    {
      name: 'an agent row without the memo is still the agent, and a null one too',
      rows: [row(AGENT, { botMemo: false }), row(AGENT, { secs: 9, botMemo: null })],
      memo: [],
      agent: { swaps: 2, wallets: 1, volumeUsdc: '2' },
      fans: zero,
      others: zero,
      lastAgent: T0 + 9,
      lastFan: null,
    },
    {
      name: 'the agent is never a rate bot',
      rows: burst(AGENT, 25, 1),
      memo: [AGENT],
      agent: { swaps: 25, wallets: 1, volumeUsdc: '25' },
      fans: zero,
      others: zero,
      lastAgent: T0 + 24,
      lastFan: null,
    },
    {
      name: '19 quick swaps are still a fan',
      rows: burst('Quick', 19, 1),
      memo: [],
      agent: zero,
      fans: { swaps: 19, wallets: 1, volumeUsdc: '19' },
      others: zero,
      lastAgent: null,
      lastFan: T0 + 18,
    },
    {
      name: 'a YES<->NO swap counts as a swap and adds 0 volume',
      rows: [row('FanA', { usdc: 0n, direction: 'yesToNo' }), row('FanA', { usdc: 2_000_000n })],
      memo: [],
      agent: zero,
      fans: { swaps: 2, wallets: 1, volumeUsdc: '2' },
      others: zero,
      lastAgent: null,
      lastFan: T0,
    },
    {
      name: 'bigint sums are exact: 0.1 + 0.2 is 0.3',
      rows: [row('FanA', { usdc: 100_000n }), row('FanB', { usdc: 200_000n })],
      memo: [],
      agent: zero,
      fans: { swaps: 2, wallets: 2, volumeUsdc: '0.3' },
      others: zero,
      lastAgent: null,
      lastFan: T0,
    },
  ])('$name', (c) => {
    const a = gameActivity(c.rows, new Set(c.memo))
    expect(a).toEqual({
      agent: { ...c.agent, wallet: AGENT },
      fans: c.fans,
      others: c.others,
      lastAgentTradeTs: c.lastAgent,
      lastFanTradeTs: c.lastFan,
    })
    expect(GameActivitySchema.parse(a)).toEqual(a)
  })

  it('counts a wallet once, with all its swaps, in the first class it meets', () => {
    // A listed team wallet that also sent the memo and a burst is team: others, once.
    const rows = [...burst(TEAM, 20, 1), row(TEAM, { botMemo: true })]
    expect(gameActivity(rows, new Set([TEAM])).others).toEqual({
      swaps: 21,
      wallets: 1,
      volumeUsdc: '21',
    })
  })

  it('takes another agent wallet when given one', () => {
    const a = gameActivity([row('OtherAgent'), row(AGENT)], new Set(), 'OtherAgent')
    expect(a.agent).toEqual({ swaps: 1, wallets: 1, volumeUsdc: '1', wallet: 'OtherAgent' })
    // The default agent is a listed team wallet when it is not the agent.
    expect(a.others.wallets).toBe(1)
  })
})

describe('isRateBot: the same answer as scripts/count-fans.mjs', () => {
  const at = (...gaps: number[]) => gaps.map((g, i) => 1_000 + i * g)
  const spread = (n: number, span: number) =>
    Array.from({ length: n }, (_, i) => 1_000 + (i === n - 1 ? span : i))

  it.each([
    { name: '19 swaps in 10 s', times: spread(19, 10), want: false },
    { name: '20 swaps in 10 s', times: spread(20, 10), want: true },
    { name: '20 swaps over 299 s', times: spread(20, 299), want: true },
    { name: '20 swaps over 300 s', times: spread(20, 300), want: false },
    { name: '20 swaps, 16 s apart', times: at(...Array(20).fill(16)), want: false },
    { name: '20 swaps, 15 s apart', times: at(...Array(20).fill(15)), want: true },
    { name: 'unsorted', times: spread(20, 299).reverse(), want: true },
    { name: 'none', times: [], want: false },
  ])('$name', ({ times, want }) => {
    expect(isRateBot(times)).toBe(want)
    expect(countFansIsRateBot(times)).toBe(want)
  })

  it('agrees on any list of block times', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 2_000 }), { maxLength: 60 }), (times) => {
        expect(isRateBot(times)).toBe(countFansIsRateBot(times))
      }),
      { numRuns: 500 },
    )
  })

  it('uses the same rate as count-fans', () => {
    expect(BOT_RATE).toEqual(COUNT_FANS_BOT_RATE)
  })
})

describe('TEAM_WALLETS: the copy of docs/metrics-wallets.json', () => {
  const file = JSON.parse(
    readFileSync(new URL('../../../docs/metrics-wallets.json', import.meta.url), 'utf8'),
  ) as { teamWallets: Array<{ pubkey: string; role: string }> }

  it('holds exactly the listed team wallets', () => {
    expect(new Set(TEAM_WALLETS)).toEqual(new Set(file.teamWallets.map((w) => w.pubkey)))
  })

  it('lists the reference agent as team-burner', () => {
    expect(file.teamWallets.filter((w) => w.pubkey === REFERENCE_AGENT_WALLET)).toEqual([
      { pubkey: REFERENCE_AGENT_WALLET, role: 'team-burner', addedAt: expect.any(String) },
    ])
  })
})
