import type { MarketRow } from '@horagon/db'
import { describe, expect, it } from 'vitest'
import {
  etDayRange,
  etNextDay,
  etToday,
  marketRules,
  type RuleMarket,
  spanWords,
  toResolution,
} from '../src/views'

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

describe('market rules (M6): the close read from each market', () => {
  const tip = new Date('2026-11-25T01:00:00Z')
  const game = { home: 'MEM', away: 'CHA', scheduledTipoff: tip }
  const tipPlus = (secs: number) => new Date(tip.getTime() + secs * 1000)
  const market = (over: Partial<RuleMarket> = {}): RuleMarket => ({
    kind: 0,
    status: 'open',
    endTs: tipPlus(10_800),
    haltSig: null,
    ...over,
  })
  const rules = (m: RuleMarket[], windowSecs: number | null = 900) =>
    marketRules(game, m, windowSecs).join(' ')

  it('say when an open market closes: the buzzer, the first Final read, its own end_ts', () => {
    const text = rules([market()])
    expect(text).toContain(
      'A market closes at the final buzzer (the keeper halts it on the first Final read), or 3 hours after the scheduled tip-off at the latest.',
    )
    expect(text).not.toContain('if the game ends before the market closes')
    // A Practice market ends 30 min after its replayed tip-off.
    expect(rules([market({ endTs: tipPlus(1_800) })])).toContain(
      'or 30 minutes after the scheduled tip-off at the latest.',
    )
  })

  it('say a shakedown market closed at its 2 h 10 min end_ts with no halt, not at the buzzer', () => {
    const text = rules([market({ status: 'recycled', endTs: tipPlus(7_800) })])
    expect(text).toContain(
      'This market closed at its end time, 2 h 10 min after the scheduled tip-off: it was never halted, so it did not close at the final buzzer.',
    )
    expect(text).not.toContain('3 hours')
    expect(text).not.toContain('closes at the final buzzer')
  })

  it('say a halted market closed with its halt, before its own latest close', () => {
    for (const status of ['halted', 'proposed', 'recycled']) {
      const text = rules([market({ status, haltSig: '5'.repeat(88) })])
      expect(text, status).toContain(
        'This market closed with a halt, before its latest close 3 hours after the scheduled tip-off.',
      )
    }
  })

  it('name no end time before the game has a market, and follow the winner market', () => {
    const none = marketRules({ ...game, home: 'MEM' }, [], 900).join(' ')
    expect(none).toContain(
      'or at the latest at the end time the keeper sets when it creates the market.',
    )
    expect(none).not.toContain('3 hours after')
    const both = rules([market({ kind: 1, endTs: tipPlus(7_800) }), market()])
    expect(both).toContain('or 3 hours after the scheduled tip-off at the latest.')
  })

  it("give the challenge window as the Config's setting today, never as fixed", () => {
    expect(rules([market()], 900)).toContain(
      "can be challenged by a guardian for 15 minutes before they become final. The window is a setting in the program's Config that the admin key can change, from 60 s to 7 days. Play money on devnet: no real value, no prizes.",
    )
    expect(rules([market()], 3_600)).toContain('challenged by a guardian for 1 hour before')
    const unread = rules([market()], null)
    expect(unread).toContain('challenged by a guardian during the challenge window before')
    expect(unread).not.toContain('15 minutes')
  })
})

describe('spanWords', () => {
  it.each([
    [10_800, '3 hours'],
    [7_800, '2 h 10 min'],
    [1_800, '30 minutes'],
    [900, '15 minutes'],
    [60, '1 minute'],
    [3_600, '1 hour'],
    [45, '45 seconds'],
    [90, '1 min 30 s'],
    [604_800, '7 days'],
  ])('%i s reads "%s"', (secs, words) => {
    expect(spanWords(secs)).toBe(words)
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
