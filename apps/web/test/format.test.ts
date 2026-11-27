import type { Game } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import {
  cents,
  countdown,
  explorerAddress,
  explorerTx,
  gameClock,
  isTonight,
  percent,
  shortKey,
  sideLabel,
  usdc,
} from '../lib/format'

const TIP = '2026-11-25T00:30:00.000Z'
const clock = (over: Partial<Parameters<typeof gameClock>[0]>) =>
  gameClock(
    { status: 'live', period: 1, clockSecs: 720, scheduledTipoff: TIP, ...over },
    'America/New_York',
  )

describe('gameClock', () => {
  it('formats every status', () => {
    expect(clock({ status: 'scheduled' })).toBe('7:30 PM')
    expect(clock({ period: 3, clockSecs: 312 })).toBe('Q3 5:12')
    expect(clock({ period: 2, clockSecs: 0 })).toBe('Half')
    expect(clock({ period: 4, clockSecs: 0 })).toBe('End Q4')
    // ESPN halftime and the end of Q1 or Q3 read 0 s (keeper feeds/espn.ts).
    expect(clock({ period: 1, clockSecs: 0 })).toBe('End Q1')
    expect(clock({ period: 3, clockSecs: 0 })).toBe('End Q3')
    // Free throws at 0.0 of Q4 or an overtime read 1 s: time left, not the horn.
    expect(clock({ period: 4, clockSecs: 1 })).toBe('Q4 0:01')
    expect(clock({ period: 5, clockSecs: 65 })).toBe('OT 1:05')
    expect(clock({ period: 6, clockSecs: null })).toBe('2OT')
    expect(clock({ status: 'final', period: 4 })).toBe('Final')
    expect(clock({ status: 'final', period: 5 })).toBe('Final/OT')
    expect(clock({ status: 'postponed' })).toBe('Postponed')
    expect(clock({ status: 'canceled' })).toBe('Canceled')
  })
})

describe('countdown and prices', () => {
  it('counts down to end_ts and stops at Closed', () => {
    expect(countdown(1_000 + 3_723, 1_000)).toBe('1:02:03')
    expect(countdown(1_000 + 245, 1_000)).toBe('4:05')
    expect(countdown(1_000, 1_000)).toBe('Closed')
    expect(countdown(1_000, 2_000)).toBe('Closed')
  })

  it('shows cents and a dash for no price', () => {
    expect(cents(0.624)).toBe('62¢')
    expect(cents(null)).toBe('–')
  })

  it('keeps the edges honest and rounds balances down', () => {
    expect(cents(0.004)).toBe('<1¢')
    expect(cents(0.996)).toBe('>99¢')
    expect(cents(0.01)).toBe('1¢')
    expect(cents(0.99)).toBe('99¢')
    expect(cents(0)).toBe('0¢')
    expect(cents(1)).toBe('100¢')
    expect(percent(0.004)).toBe('<1%')
    expect(percent(0.996)).toBe('>99%')
    expect(percent(0.5)).toBe('50%')
    expect(usdc('99.999')).toBe('99.99')
    expect(usdc('100')).toBe('100.00')
    expect(usdc('5.5')).toBe('5.50')
    expect(usdc('1234567.899999')).toBe('1,234,567.89')
    expect(usdc(99.999)).toBe('99.99')
    expect(usdc('1e3')).toBe('1,000.00')
  })

  it('keeps exponent forms exact to the cent (R7)', () => {
    expect(usdc('2.9e-1')).toBe('0.29')
    expect(usdc(0.29)).toBe('0.29')
    expect(usdc('1e-7')).toBe('0.00')
    expect(usdc(1e-7)).toBe('0.00')
    expect(usdc('5.7e-1')).toBe('0.57')
    expect(usdc('1.0099e2')).toBe('100.99')
    expect(usdc('-1.5')).toBe('-1.50')
  })

  it('shows percent, amounts, short keys and explorer links', () => {
    expect(percent(0.624)).toBe('62%')
    expect(percent(undefined)).toBe('–')
    expect(usdc('1234.5')).toBe('1,234.50')
    expect(usdc(7)).toBe('7.00')
    expect(shortKey('So11111111111111111111111111111111111111112')).toBe('So11…1112')
    expect(explorerTx('abc')).toBe('https://explorer.solana.com/tx/abc?cluster=devnet')
    expect(explorerAddress('abc')).toBe('https://explorer.solana.com/address/abc?cluster=devnet')
  })

  it('points a localnet link at the local validator (custom cluster), never at devnet', () => {
    expect(explorerTx('abc', 'localnet')).toBe(
      'https://explorer.solana.com/tx/abc?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899',
    )
    expect(explorerAddress('abc', 'localnet')).toBe(
      'https://explorer.solana.com/address/abc?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899',
    )
    expect(explorerTx('abc', 'devnet')).toBe('https://explorer.solana.com/tx/abc?cluster=devnet')
  })

  it('names the team of a side, HOME or AWAY only when the game is not known', () => {
    const teams = { home: 'MEM', away: 'LAL' }
    expect(sideLabel('home', teams)).toBe('MEM')
    expect(sideLabel('away', teams)).toBe('LAL')
    expect(sideLabel('home')).toBe('HOME')
    expect(sideLabel('away', undefined)).toBe('AWAY')
  })
})

const game = (over: Partial<Game>): Game => ({
  id: 'nba-1',
  league: 'NBA',
  home: 'BOS',
  away: 'NYK',
  scheduledTipoff: TIP,
  status: 'scheduled',
  homeScore: 0,
  awayScore: 0,
  period: 0,
  clockSecs: null,
  featured: false,
  modelProb: null,
  markets: [],
  updatedAt: TIP,
  ...over,
})

describe('Tonight list', () => {
  const now = Date.parse(TIP)
  it('keeps the next 24 h in viewer time and any live game', () => {
    expect(isTonight(game({}), now - 23 * 3_600_000)).toBe(true)
    expect(isTonight(game({}), now - 25 * 3_600_000)).toBe(false)
    expect(isTonight(game({}), now + 5 * 3_600_000)).toBe(false)
    expect(isTonight(game({ status: 'live' }), now + 9 * 3_600_000)).toBe(true)
  })
})
