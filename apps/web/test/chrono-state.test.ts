import type { Game, MarketSummary } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import { proposedOutcome } from '../lib/chrono/evidence'
import { game as sample } from '../lib/chrono/fixtures'
import {
  CLOSING_SECS,
  DIAL_STATES,
  deriveDialState,
  dialLabel,
  needlePrice,
  secsToClose,
} from '../lib/chrono/state'

const END = 10_000
const market = (over: Partial<MarketSummary> = {}): MarketSummary => ({
  pubkey: 'So11111111111111111111111111111111111111112',
  kind: 'winner',
  status: 'open',
  endTs: END,
  initialPriceBps: 5_000,
  seedUsdc: '1000',
  price: 0.77,
  priceTs: 1_000,
  outcome: null,
  ...over,
})
const game = (status: Game['status']) => ({ status })
const state = (g: Game['status'], m: MarketSummary | undefined, now = 2_000) =>
  deriveDialState(game(g), m, now)

describe('deriveDialState: the table of spec 4.3, in order', () => {
  it('row 1: a finalized or recycled market is resolved', () => {
    expect(state('final', market({ status: 'finalized', outcome: 'yes' }))).toBe('resolved')
    expect(state('final', market({ status: 'recycled', outcome: 'no' }))).toBe('resolved')
  })

  it('rows 2 and 3: challenged, then proposed', () => {
    expect(state('final', market({ status: 'challenged' }))).toBe('challenged')
    expect(state('final', market({ status: 'proposed' }))).toBe('proposed')
  })

  it('row 4: a postponed or canceled game is void', () => {
    expect(state('postponed', market())).toBe('void')
    expect(state('canceled', market({ status: 'halted' }))).toBe('void')
    expect(state('postponed', undefined)).toBe('void')
  })

  it('a result on the market beats a void game, so the winners still see Claim all', () => {
    expect(state('postponed', market({ status: 'finalized', outcome: 'no' }))).toBe('resolved')
    expect(state('postponed', market({ status: 'proposed' }))).toBe('proposed')
    expect(state('canceled', market({ status: 'challenged' }))).toBe('challenged')
  })

  it('row 5: halted while the game is on the court', () => {
    expect(state('live', market({ status: 'halted' }))).toBe('halted')
    expect(state('live', market({ status: 'halted' }), END + 50)).toBe('halted')
    expect(state('scheduled', market({ status: 'halted' }))).toBe('halted')
  })

  it('row 5 at the final buzzer (R1): a halt under a final game is the normal close', () => {
    expect(state('final', market({ status: 'halted' }))).toBe('closed')
    expect(state('final', market({ status: 'halted' }), END + 50)).toBe('closed')
  })

  it('row 6: open at or after end_ts is closed', () => {
    expect(state('live', market(), END)).toBe('closed')
    expect(state('final', market(), END + 1)).toBe('closed')
  })

  it('row 7: open with 300 s or less to go is closing', () => {
    expect(state('live', market(), END - CLOSING_SECS)).toBe('closing')
    expect(state('scheduled', market(), END - 1)).toBe('closing')
    expect(state('live', market(), END - CLOSING_SECS - 1)).toBe('live')
  })

  it('rows 8 and 9: live while the game is live or final, pre before tip-off', () => {
    expect(state('live', market())).toBe('live')
    expect(state('final', market())).toBe('live')
    expect(state('scheduled', market())).toBe('pre')
  })

  it('row 10: no market yet is pre', () => {
    expect(state('scheduled', undefined)).toBe('pre')
    expect(state('live', undefined)).toBe('pre')
  })

  it('uses chain time when the device clock lags it (effectiveTime)', () => {
    // The device says 9,500 but the chain already priced at 10,000: trading has closed.
    expect(state('live', market({ priceTs: END }), END - 500)).toBe('closed')
    expect(state('live', market({ priceTs: END - 200 }), END - 900)).toBe('closing')
    expect(state('live', market({ priceTs: null }), END - 900)).toBe('live')
  })

  it('lists every state once', () => {
    expect(new Set(DIAL_STATES).size).toBe(9)
  })
})

describe('secsToClose', () => {
  it('counts down to end_ts in chain time and stops at 0', () => {
    expect(secsToClose(market(), 6_280)).toBe(3_720)
    expect(secsToClose(market({ priceTs: 9_000 }), 6_280)).toBe(1_000)
    expect(secsToClose(market(), END + 5)).toBe(0)
    expect(secsToClose(undefined, 6_280)).toBeNull()
  })
})

describe('needlePrice', () => {
  it('follows the price while trading, and has none without a price (Review Focus 1)', () => {
    expect(needlePrice('live', market())).toBe(0.77)
    expect(needlePrice('live', market({ price: null }))).toBeNull()
    expect(needlePrice('pre', undefined)).toBeNull()
  })

  it('locks at 100 or 0 once resolved, and hides for a void game', () => {
    expect(needlePrice('resolved', market({ outcome: 'yes' }))).toBe(1)
    expect(needlePrice('resolved', market({ outcome: 'no' }))).toBe(0)
    expect(needlePrice('void', market())).toBeNull()
  })

  it('turns toward the proposed side once the evidence names it', () => {
    expect(needlePrice('proposed', market(), 'yes')).toBe(1)
    expect(needlePrice('proposed', market(), 'no')).toBe(0)
    expect(needlePrice('proposed', market())).toBe(0.77)
  })
})

describe('proposedOutcome', () => {
  const evidence = {
    v: 1,
    league: 'NBA',
    gameId: '401810001',
    kind: 0,
    home: 'CLE',
    away: 'MEM',
    homeScore: 100,
    awayScore: 87,
    periods: [
      [30, 20],
      [25, 25],
      [20, 22],
      [25, 20],
    ],
    status: 'final',
    rule: 'winner-incl-ot',
    outcome: 'yes',
    sources: [{ name: 'espn', url: 'https://example.com/g', fetchedAt: '2026-11-25T03:01:12Z' }],
  }

  it('reads the outcome of valid evidence', () => {
    expect(proposedOutcome(JSON.stringify(evidence))).toBe('yes')
  })

  it('is null for text that is not valid evidence', () => {
    expect(proposedOutcome('{')).toBeNull()
    expect(proposedOutcome(JSON.stringify({ ...evidence, outcome: 'no' }))).toBeNull()
  })
})

describe('dialLabel (spec 2.6, R5)', () => {
  const base = {
    game: sample(),
    outcome: null,
    price: 0.77,
    modelProb: 0.74,
    state: 'live' as const,
    secsLeft: 3_720,
  }
  const final = (homeScore: number, awayScore: number) =>
    sample({ status: 'final', homeScore, awayScore })

  it('reads the whole dial in one sentence, subject first', () => {
    expect(dialLabel(base)).toBe('CLE to win, 77%, model 74%, open until the final buzzer')
    const scheduled = sample({ status: 'scheduled' })
    expect(dialLabel({ ...base, state: 'pre', game: scheduled })).toMatch(
      /open until the final buzzer$/,
    )
  })

  it('counts down only in the last 5 min before end_ts, when the market closes then', () => {
    expect(dialLabel({ ...base, state: 'closing', secsLeft: 252 })).toBe(
      'CLE to win, 77%, model 74%, closes in 4 minutes',
    )
  })

  it('says when there is no price, model or market yet', () => {
    expect(dialLabel({ ...base, price: null, modelProb: null, state: 'pre', secsLeft: null })).toBe(
      'CLE to win, no price yet, market opens 60 min before tip-off',
    )
  })

  it('names every non-trading state', () => {
    expect(dialLabel({ ...base, state: 'closed' })).toMatch(/trading closed, result pending$/)
    expect(dialLabel({ ...base, state: 'halted' })).toMatch(/trading halted$/)
    expect(dialLabel({ ...base, state: 'proposed' })).toMatch(/result proposed$/)
    expect(dialLabel({ ...base, state: 'challenged' })).toMatch(/under review$/)
    expect(
      dialLabel({ ...base, game: final(84, 78), outcome: 'yes', state: 'resolved', price: 1 }),
    ).toBe('Resolved: CLE won, model 74%, result final')
    expect(dialLabel({ ...base, game: sample({ status: 'postponed' }), state: 'void' })).toBe(
      'model 74%, game postponed',
    )
  })

  it('never says the losing side wins once the game is over (audit finding 2)', () => {
    const lost = dialLabel({ ...base, game: final(105, 107), state: 'closed', price: 0.74 })
    // "result pending" once: the caption says it (R5 review finding 5).
    expect(lost).toBe('Final, CLE lost, result pending, 74%, model 74%, trading closed')
    expect(lost.match(/result pending/g)).toHaveLength(1)
    expect(lost).not.toMatch(/CLE (wins|to win)/)
  })

  it('keeps the honest edges of the price', () => {
    expect(dialLabel({ ...base, price: 0.996 })).toMatch(/^CLE to win, >99%/)
  })
})
