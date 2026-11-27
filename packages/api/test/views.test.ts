import type { MarketRow } from '@horagon/db'
import { describe, expect, it } from 'vitest'
import { etDayRange, etNextDay, etToday, marketRules, toResolution } from '../src/views'

describe('ET game dates', () => {
  it('maps an ET day to its UTC range, across both clock changes', () => {
    expect(etDayRange('2026-11-19')).toEqual({
      from: new Date('2026-11-19T05:00:00Z'),
      to: new Date('2026-11-20T05:00:00Z'),
    })
    // 2026-11-01: the clocks fall back, a 25-hour day.
    expect(etDayRange('2026-11-01')).toEqual({
      from: new Date('2026-11-01T04:00:00Z'),
      to: new Date('2026-11-02T05:00:00Z'),
    })
    // 2027-03-14: the clocks spring forward, a 23-hour day.
    expect(etDayRange('2027-03-14')).toEqual({
      from: new Date('2027-03-14T05:00:00Z'),
      to: new Date('2027-03-15T04:00:00Z'),
    })
  })

  it('dates a late tip-off on the evening it starts in ET', () => {
    // 22:30 ET on 19/11 is 03:30 UTC on 20/11: the NBA still dates it 19/11.
    expect(etToday(Date.parse('2026-11-20T03:30:00Z') / 1000)).toBe('2026-11-19')
    expect(etToday(Date.parse('2026-11-20T05:00:00Z') / 1000)).toBe('2026-11-20')
    expect(etNextDay('2026-12-31')).toBe('2027-01-01')
  })
})

describe('market rules (M6)', () => {
  it('say when a market closes: the buzzer, the first Final read, 3 h after tip-off', () => {
    const rules = marketRules({ home: 'MEM', away: 'CHA' }, [0]).join(' ')
    expect(rules).toContain(
      'closes at the final buzzer (the keeper halts it on the first Final read)',
    )
    expect(rules).toContain('3 hours after the scheduled tip-off at the latest')
    expect(rules).not.toContain('if the game ends before the market closes')
  })
})

describe('toResolution: the proposal time and the challenge window (R6 part B)', () => {
  const proposedAt = new Date('2026-11-29T01:50:00Z')
  const row = (over: Partial<MarketRow> = {}): MarketRow =>
    ({
      pubkey: 'Market1111111111111111111111111111111111111',
      gameId: 'nba-1',
      kind: 0,
      status: 'proposed',
      outcome: 'yes',
      evidenceHash: 'ab'.repeat(32),
      gameMarketPda: 'GameMarket11111111111111111111111111111111',
      proposedAt,
      createSig: null,
      haltSig: null,
      proposeSig: null,
      finalizeSig: null,
      recycleSig: null,
      externalLp: false,
      ...over,
    }) as MarketRow

  it('gives the game market, the proposal time and its end while proposed', () => {
    const r = toResolution(row(), 'https://horagon.test', 900)
    expect(r.gameMarket).toBe('GameMarket11111111111111111111111111111111')
    expect(r.proposedAt).toBe(proposedAt.getTime() / 1000)
    expect(r.challengeEndsAt).toBe(proposedAt.getTime() / 1000 + 900)
  })

  it('gives no end when the window is unread, or once the market is no longer proposed', () => {
    expect(toResolution(row(), 'https://horagon.test', null).challengeEndsAt).toBeNull()
    const done = toResolution(row({ status: 'finalized' }), 'https://horagon.test', 900)
    expect(done.challengeEndsAt).toBeNull()
    expect(done.proposedAt).toBe(proposedAt.getTime() / 1000)
    const open = toResolution(
      row({ status: 'open', proposedAt: null }),
      'https://horagon.test',
      900,
    )
    expect(open.proposedAt).toBeNull()
    expect(open.challengeEndsAt).toBeNull()
  })
})
