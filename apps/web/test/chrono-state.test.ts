import type { Game, MarketSummary } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import { proposedOutcome } from '../lib/chrono/evidence'
import { game as sample } from '../lib/chrono/fixtures'
import {
  CLOSING_SECS,
  crownLabel,
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

  it('the final buzzer closes an open market before end_ts, before the keeper halt lands (R5c)', () => {
    // The API can serve a final game with its market still open for a few seconds: the keeper
    // writes Final, then its halt confirms and reaches the index.
    expect(state('final', market())).toBe('closed')
    expect(state('final', market(), END - CLOSING_SECS)).toBe('closed')
    expect(state('final', market({ priceTs: null }), 0)).toBe('closed')
    // A result on the market still wins over the buzzer.
    expect(state('final', market({ status: 'proposed' }))).toBe('proposed')
    expect(state('final', market({ status: 'finalized', outcome: 'no' }))).toBe('resolved')
  })

  it('rows 8 and 9: live while the game is live, pre before tip-off', () => {
    expect(state('live', market())).toBe('live')
    expect(state('scheduled', market())).toBe('pre')
  })

  it('row 10: no market yet is pre, also once the game started', () => {
    expect(state('scheduled', undefined)).toBe('pre')
    expect(state('live', undefined)).toBe('pre')
    expect(state('final', undefined)).toBe('pre')
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
    const scheduled = sample({ status: 'scheduled' })
    const none = { ...base, game: scheduled, price: null, modelProb: null, state: 'pre' as const }
    expect(dialLabel({ ...none, secsLeft: null })).toBe(
      'CLE to win, no price yet, market opens 60 min before tip-off',
    )
  })

  it('says a game that started with no market has none, never a past opening (R5c)', () => {
    const none = { ...base, price: null, modelProb: null, state: 'pre' as const, secsLeft: null }
    expect(dialLabel(none)).toBe('CLE to win, no price yet, no market for this game')
    const over = dialLabel({ ...none, game: final(105, 107) })
    expect(over).toBe('Final, CLE lost, no price yet, no market for this game')
    expect(over).not.toMatch(/opens|result pending/)
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

  it('never says "result pending" next to a proposed or challenged result (R5c)', () => {
    const over = { ...base, game: final(105, 107), price: 0.74 }
    expect(dialLabel({ ...over, state: 'proposed' })).toBe(
      'Final, CLE lost, 74%, model 74%, result proposed',
    )
    expect(dialLabel({ ...over, state: 'challenged' })).toBe(
      'Final, CLE lost, 74%, model 74%, result under review',
    )
    // The kind comes from the verdict, not from the caption's words: a game with no winner yet
    // on the scoreboard says it the same way.
    const tied = { ...base, game: final(100, 100), price: 0.5 }
    expect(dialLabel({ ...tied, state: 'proposed' })).toBe('Final, 50%, model 74%, result proposed')
    expect(dialLabel({ ...tied, state: 'closed' })).toBe(
      'Final, result pending, 50%, model 74%, trading closed',
    )
    for (const state of ['proposed', 'challenged', 'closed'] as const) {
      const said = dialLabel({ ...over, state })
      expect(said.match(/result (pending|proposed|under review)/g), state).toHaveLength(1)
    }
  })

  it('keeps the honest edges of the price', () => {
    expect(dialLabel({ ...base, price: 0.996 })).toMatch(/^CLE to win, >99%/)
  })
})

describe('crownLabel (R5c, review finding 4)', () => {
  const over = sample({ status: 'final', homeScore: 104, awayScore: 110 })
  const base = { state: 'live' as const, game: sample(), outcome: null, price: 0.77, ghost: null }

  it('reads the caption, the price and the price after the quoted trade', () => {
    expect(crownLabel(base)).toBe('CLE to win, 77%')
    expect(crownLabel({ ...base, ghost: 0.79 })).toBe('CLE to win, 77%, after this trade 79%')
    expect(crownLabel({ ...base, price: null })).toBe('CLE to win, no price yet')
  })

  it('never reads a side that lost as "to win" once the crown stays on after the buzzer', () => {
    const said = crownLabel({ ...base, state: 'closed', game: over })
    expect(said).toBe('Final, CLE lost, result pending, 77%')
    expect(said).not.toMatch(/to win/)
    const won = sample({ status: 'final', homeScore: 110, awayScore: 104 })
    expect(crownLabel({ ...base, state: 'closed', game: won })).toBe(
      'Final, CLE won, result pending, 77%',
    )
  })
})
