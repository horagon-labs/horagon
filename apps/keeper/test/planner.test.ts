import type { DraftRow, GameRow, MarketRow } from '@horagon/db'
import type { GameMarketAccount, GameMarketStatus } from '@horagon/sdk'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { FeedGame } from '../src/feeds/types'
import {
  DEFAULT_SEEDS,
  DEFAULT_TIMINGS,
  type GameState,
  type PlanInput,
  plan,
  priceBps,
} from '../src/planner'

const S = 1_795_000_000 // scheduled tip-off, unix seconds
const END = S + DEFAULT_TIMINGS.endOffsetSecs

function game(patch: Partial<GameRow> = {}): GameRow {
  return {
    id: 'nba-401910007',
    league: 'NBA',
    externalId: '401910007',
    gameDate: '2026-11-18',
    home: 'CLE',
    away: 'MEM',
    scheduledTipoff: new Date(S * 1000),
    status: 'scheduled',
    homeScore: 0,
    awayScore: 0,
    period: 0,
    clockSecs: null,
    periods: [],
    featured: false,
    p0: 0.62,
    modelProb: null,
    feedUpdatedAt: null,
    updatedAt: new Date(0),
    ...patch,
  } as GameRow
}

function market(status: GameMarketStatus = 'open'): MarketRow {
  return { pubkey: 'm', gameId: 'nba-401910007', kind: 0, marketId: '7', status } as MarketRow
}

function chain(
  status: GameMarketStatus,
  patch: Partial<GameMarketAccount> = {},
): GameMarketAccount {
  return {
    market: PublicKey.default,
    marketId: 7n,
    kind: 0,
    league: 'NBA',
    externalGameId: '401910007',
    home: 'CLE',
    away: 'MEM',
    scheduledTipoff: S,
    endTs: END,
    seedAmount: 300_000_000n,
    status,
    proposedOutcome: null,
    evidenceHash: new Uint8Array(32),
    evidenceUri: '',
    proposedAt: 0,
    proposer: PublicKey.default,
    challengeCount: 0,
    finalizedAt: 0,
    bump: 255,
    ...patch,
  }
}

const QUARTERS: Array<[number, number]> = [
  [30, 25],
  [28, 27],
  [26, 30],
  [27, 24],
]

function feed(patch: Partial<FeedGame> = {}): FeedGame {
  return {
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
    ...patch,
  }
}

const finalFeed = feed({
  status: 'final',
  period: 4,
  homeScore: 111,
  awayScore: 106,
  periods: QUARTERS,
})

function state(patch: Partial<GameState> = {}): GameState {
  return {
    game: game(),
    market: null,
    onchain: null,
    feed: feed(),
    feedSeenAt: null,
    finalSince: null,
    draft: null,
    ...patch,
  }
}

function run(now: number, ...states: GameState[]) {
  const input: PlanInput = {
    now,
    states,
    timings: DEFAULT_TIMINGS,
    seeds: DEFAULT_SEEDS,
    disputeWindowSecs: 900,
  }
  return plan(input)
}

const types = (actions: ReturnType<typeof run>) => actions.map((a) => a.type)

describe('create', () => {
  it('creates the winner market from S - 60 min, priced at p0, ending at S + 2h10m', () => {
    expect(run(S - 3_601, state())).toEqual([])
    expect(run(S - 3_600, state())).toEqual([
      {
        type: 'create',
        gameId: 'nba-401910007',
        kind: 0,
        initialPriceBps: 6_200,
        endTs: END,
        seedAmount: 300_000_000n,
        featured: false,
      },
    ])
  })

  it('seeds a featured game with 1,000 mUSDC', () => {
    const [a] = run(S - 100, state({ game: game({ featured: true }) }))
    expect(a).toMatchObject({ type: 'create', seedAmount: 1_000_000_000n, featured: true })
  })

  it('never creates once the game is live, postponed, or past the grace period', () => {
    expect(run(S + 60, state({ feed: feed({ status: 'live', period: 1 }) }))).toEqual([])
    expect(run(S - 100, state({ feed: feed({ status: 'postponed' }) }))).toEqual([])
    expect(run(S + DEFAULT_TIMINGS.createGraceSecs, state())).toEqual([])
    expect(run(S - 100, state({ game: game({ status: 'postponed' }) }))).toEqual([])
  })

  it('alerts instead of creating when p0 is missing', () => {
    expect(types(run(S - 100, state({ game: game({ p0: null }) })))).toEqual(['alert'])
  })

  it('clamps the initial price to the program range', () => {
    expect(priceBps(0.01)).toBe(500)
    expect(priceBps(0.99)).toBe(9_500)
    expect(priceBps(0.61234)).toBe(6_123)
  })
})

describe('halt (spec 6.2)', () => {
  const open = (patch: Partial<GameState>) =>
    state({ market: market('open'), onchain: chain('open'), ...patch })

  it('halts when the feed says Final before end_ts', () => {
    expect(run(END - 600, open({ feed: finalFeed }))[0]).toMatchObject({
      type: 'halt',
      rule: 'final-before-end',
    })
  })

  it('does not halt for Final after end_ts', () => {
    expect(types(run(END + 10, open({ feed: finalFeed })))).not.toContain('halt')
  })

  it('halts a postponed or canceled game', () => {
    expect(run(S - 600, open({ feed: feed({ status: 'postponed' }) }))[0]).toMatchObject({
      rule: 'postponed',
    })
    expect(run(S - 600, open({ feed: feed({ status: 'canceled' }) }))[0]).toMatchObject({
      rule: 'postponed',
    })
  })

  it('halts a game not started 24 h after the on-chain tip-off, even if the DB moved it', () => {
    const moved = game({ scheduledTipoff: new Date((S + 3 * 86_400) * 1000) })
    expect(run(S + 86_399, open({ game: moved }))).toEqual([])
    expect(run(S + 86_400, open({ game: moved }))[0]).toMatchObject({ rule: 'not-started' })
  })

  it('alerts when the feed is silent > 2 min in Q4 or OT before end_ts, and halts > 10 min', () => {
    const live = feed({ status: 'live', period: 4, clockSecs: 300, homeScore: 90, awayScore: 88 })
    const now = END - 900
    expect(run(now, open({ feed: live, feedSeenAt: now - 120 }))).toEqual([])
    expect(run(now, open({ feed: live, feedSeenAt: now - 121 }))).toEqual([
      expect.objectContaining({ type: 'alert', key: 'feed-silent:nba-401910007' }),
    ])
    expect(types(run(now, open({ feed: live, feedSeenAt: now - 600 })))).toEqual(['alert'])
    const halted = run(now, open({ feed: live, feedSeenAt: now - 601 }))
    expect(types(halted)).toEqual(['halt'])
    expect(halted[0]).toMatchObject({ rule: 'feed-silent' })
    const ot = feed({ ...live, period: 5 })
    expect(types(run(now, open({ feed: ot, feedSeenAt: now - 601 })))).toEqual(['halt'])
    // From end_ts on, swaps are blocked anyway: no alert, no halt.
    expect(run(END, open({ feed: live, feedSeenAt: END - 900 }))).toEqual([])
  })

  it('alerts, never halts, on a feed silent > 2 min in the last 30 min, whatever it last showed', () => {
    const q3 = feed({ status: 'live', period: 3, clockSecs: 40, homeScore: 70, awayScore: 66 })
    const watch = END - DEFAULT_TIMINGS.feedSilentWatchSecs
    // Before the watch, a game last seen in Q3 cannot be about to end: nothing.
    expect(run(watch - 1, open({ feed: q3, feedSeenAt: watch - 900 }))).toEqual([])
    expect(run(watch, open({ feed: q3, feedSeenAt: watch - 120 }))).toEqual([])
    expect(run(watch, open({ feed: q3, feedSeenAt: watch - 121 }))).toEqual([
      expect.objectContaining({
        type: 'alert',
        key: 'feed-silent:nba-401910007',
        text: expect.stringContaining('last seen in Q3'),
      }),
    ])
    // An outage from Q3 into what may now be Q4 still only alerts: the keeper cannot tell.
    expect(types(run(END - 1, open({ feed: q3, feedSeenAt: watch - 3_600 })))).toEqual(['alert'])
    // Last seen before tip-off, or not read at all since the keeper started.
    const pre = feed({ status: 'scheduled' })
    expect(types(run(watch, open({ feed: pre, feedSeenAt: S - 60 })))).toEqual(['alert'])
    expect(types(run(watch, open({ feed: null, feedSeenAt: null })))).toEqual(['alert'])
    expect(run(watch - 1, open({ feed: null, feedSeenAt: null }))).toEqual([])
    // A feed that reads fine is quiet, whatever it shows; from end_ts on, nothing.
    expect(run(END - 60, open({ feed: q3, feedSeenAt: END - 75 }))).toEqual([])
    expect(run(END, open({ feed: q3, feedSeenAt: END - 900 }))).toEqual([])
  })

  it('puts halts before every other action', () => {
    const other = state({ game: game({ id: 'nba-2' }) })
    const actions = run(S - 100, other, open({ feed: feed({ status: 'postponed' }) }))
    expect(types(actions)).toEqual(['halt', 'create'])
  })
})

describe('draft, finalize, recycle', () => {
  const halted = (patch: Partial<GameState>) =>
    state({ market: market('halted'), onchain: chain('halted'), ...patch })

  it('drafts after 60 s of a stable Final whose periods add up', () => {
    const now = END + 100
    expect(run(now, halted({ feed: finalFeed, finalSince: now - 59 }))).toEqual([])
    expect(run(now, halted({ feed: finalFeed, finalSince: now - 60 }))).toEqual([
      {
        type: 'draft',
        gameId: 'nba-401910007',
        status: 'final',
        homeScore: 111,
        awayScore: 106,
        periods: QUARTERS,
      },
    ])
  })

  it('alerts instead of drafting when ESPN periods do not add up', () => {
    const bad = feed({ ...finalFeed, periods: QUARTERS.slice(0, 3) })
    const now = END + 100
    expect(types(run(now, halted({ feed: bad, finalSince: now - 600 })))).toEqual(['alert'])
  })

  it('drafts a NO for a game not made up within 7 days', () => {
    const postponed = feed({ status: 'postponed' })
    expect(run(S + 7 * 86_400 - 1, halted({ feed: postponed }))).toEqual([])
    expect(run(S + 7 * 86_400, halted({ feed: postponed }))[0]).toMatchObject({
      type: 'draft',
      status: 'postponed',
      periods: [],
    })
  })

  it('resolves a makeup game played within 7 days by its own result', () => {
    const now = S + 3 * 86_400
    expect(run(now, halted({ feed: finalFeed, finalSince: now - 600 }))[0]).toMatchObject({
      type: 'draft',
      status: 'final',
    })
  })

  it('reminds once when the guardian has not confirmed 30 min after Final', () => {
    const draft = {
      state: 'pending',
      alertedAt: null,
      fetchedAt: new Date((END + 100) * 1000),
    } as DraftRow
    const s = halted({ feed: finalFeed, finalSince: END, draft })
    expect(run(END + 100 + 1_799, s)).toEqual([])
    expect(types(run(END + 100 + 1_800, s))).toEqual(['alert'])
    const reminded = { ...draft, alertedAt: new Date() } as DraftRow
    expect(run(END + 100 + 3_600, halted({ feed: finalFeed, draft: reminded }))).toEqual([])
  })

  it('finalizes when the dispute window has passed, then recycles', () => {
    const proposedAt = END + 500
    const proposed = state({
      market: market('proposed'),
      onchain: chain('proposed', { proposedAt }),
    })
    expect(run(proposedAt + 899, proposed)).toEqual([])
    expect(types(run(proposedAt + 900, proposed))).toEqual(['finalize'])
    const finalized = state({ market: market('finalized'), onchain: chain('finalized') })
    expect(types(run(proposedAt + 1_000, finalized))).toEqual(['recycle'])
    const recycled = state({ market: market('recycled'), onchain: chain('recycled') })
    expect(run(proposedAt + 2_000, recycled)).toEqual([])
  })

  it('syncs the DB row when the chain status moved', () => {
    const s = state({ market: market('open'), onchain: chain('proposed', { proposedAt: END }) })
    expect(types(run(END + 10, s))).toEqual(['sync'])
  })

  it('drafts again when ESPN corrects the Final score before the guardian confirmed', () => {
    const now = END + 400
    const old = {
      state: 'pending',
      status: 'final',
      homeScore: 110,
      awayScore: 106,
      alertedAt: null,
      fetchedAt: new Date((END + 100) * 1000),
    } as DraftRow
    expect(run(now, halted({ feed: finalFeed, finalSince: now - 60, draft: old }))).toEqual([
      {
        type: 'draft',
        gameId: 'nba-401910007',
        status: 'final',
        homeScore: 111,
        awayScore: 106,
        periods: QUARTERS,
      },
    ])
    // The corrected score is not stable yet: wait, and do not nag the guardian meanwhile.
    expect(run(now, halted({ feed: finalFeed, finalSince: now - 10, draft: old }))).toEqual([])
    // Once proposed, a draft is never replaced; a challenge is the way to change it.
    const proposed = { ...old, state: 'proposed' } as DraftRow
    expect(run(now, halted({ feed: finalFeed, finalSince: now - 600, draft: proposed }))).toEqual(
      [],
    )
  })

  it('alerts when ESPN corrects the Final score to periods that do not add up', () => {
    const now = END + 400
    const old = {
      state: 'pending',
      status: 'final',
      homeScore: 110,
      awayScore: 106,
      alertedAt: null,
      fetchedAt: new Date((END + 100) * 1000),
    } as DraftRow
    const bad = feed({ ...finalFeed, periods: QUARTERS.slice(0, 3) })
    expect(run(now, halted({ feed: bad, finalSince: now - 600, draft: old }))).toEqual([
      {
        type: 'alert',
        gameId: 'nba-401910007',
        key: 'periods:nba-401910007',
        text: 'MEM@CLE: ESPN periods do not add up to 111-106; resolve by hand',
      },
    ])
  })

  it('drafts again after a challenge rejected the draft, then waits for the guardian', () => {
    const now = END + 5_000
    const rejected = {
      state: 'rejected',
      alertedAt: null,
      fetchedAt: new Date(END * 1000),
    } as DraftRow
    const base = {
      market: market('challenged'),
      onchain: chain('challenged'),
      feed: finalFeed,
      finalSince: now - 600,
    }
    expect(types(run(now, state({ ...base, draft: rejected })))).toEqual(['draft'])
    const pending = { ...rejected, state: 'pending', fetchedAt: new Date(now * 1000) } as DraftRow
    expect(run(now, state({ ...base, draft: pending }))).toEqual([])
  })
})
