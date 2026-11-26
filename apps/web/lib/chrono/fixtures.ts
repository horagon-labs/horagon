// Sample games for the tests and the dev-only state gallery (app/dev/chrono): one evening at
// 9:08 PM ET with a game minutes from its close, two live games and two not open yet.
import type {
  Game,
  GameActivity,
  GameDetail,
  GameHistory,
  MarketSummary,
  MeGame,
  MePosition,
  MeResponse,
  Position,
  PositionsResponse,
  Quote,
} from '@horagon/sdk'

export const at = (iso: string): number => Math.floor(Date.parse(iso) / 1000)

/** 2026-11-25 02:08 UTC, 9:08 PM ET on 2026-11-24. */
export const NOW = at('2026-11-25T02:08:00Z')
export const WALLET = 'Wa11et1111111111111111111111111111111111111'

const iso = (secs: number) => new Date(secs * 1000).toISOString()

export function market(over: Partial<MarketSummary> = {}): MarketSummary {
  return {
    pubkey: 'Mkt1111111111111111111111111111111111111111',
    kind: 'winner',
    status: 'open',
    endTs: NOW + 3_730,
    initialPriceBps: 5_000,
    seedUsdc: '1000',
    price: 0.77,
    priceTs: NOW - 5,
    outcome: null,
    ...over,
  }
}

export function game(over: Partial<Game> = {}): Game {
  return {
    id: 'nba-401810001',
    league: 'NBA',
    home: 'CLE',
    away: 'MEM',
    scheduledTipoff: iso(at('2026-11-25T01:00:00Z')),
    status: 'live',
    homeScore: 84,
    awayScore: 78,
    period: 3,
    clockSecs: 252,
    featured: false,
    modelProb: 0.74,
    markets: [market()],
    updatedAt: iso(NOW),
    ...over,
  }
}

export function detail(over: Partial<GameDetail> = {}): GameDetail {
  return {
    ...game(),
    rules: ['Winner market: YES if CLE (home) wins, overtime included. Buy MEM = buy NO.'],
    resolutions: [],
    activity: activity(),
    ...over,
  }
}

/** Who traded the game (R2b): nobody by default; the agent is REFERENCE_AGENT_WALLET. */
export function activity(over: Partial<GameActivity> = {}): GameActivity {
  const none = { swaps: 0, wallets: 0, volumeUsdc: '0' }
  return {
    agent: { ...none, wallet: '7Da24CpktL9Cp4st1iQ3U4ZKHgsRYXXEJx5oGbgFWP1Z' },
    fans: none,
    others: none,
    lastFanTradeTs: null,
    lastAgentTradeTs: null,
    ...over,
  }
}

export function position(over: Partial<Position> = {}): Position {
  return {
    market: 'Mkt1111111111111111111111111111111111111111',
    gameId: 'nba-401810001',
    kind: 'winner',
    side: 'home',
    shares: '14.1',
    costUsdc: '10',
    valueUsdc: '10.857',
    pnlUsdc: '0.857',
    price: 0.77,
    marketStatus: 'open',
    outcome: null,
    claimable: false,
    ...over,
  }
}

export function portfolio(
  positions: Position[] = [],
  usdcBalance: string | null = '493.74',
): PositionsResponse {
  return { wallet: WALLET, usdcBalance, positions }
}

/** The evening of the mockups, in no particular order. */
export function evening(): Game[] {
  const tip = (t: string) => iso(at(t))
  return [
    game({
      id: 'nba-401810002',
      home: 'ATL',
      away: 'NYK',
      homeScore: 47,
      awayScore: 44,
      period: 2,
      clockSecs: 400,
      modelProb: 0.58,
      scheduledTipoff: tip('2026-11-25T01:30:00Z'),
      markets: [
        market({ pubkey: 'Mkt2222222222222222222222222222222222222222', endTs: NOW + 5_530 }),
      ],
    }),
    game(),
    game({
      id: 'nba-401810003',
      home: 'MIL',
      away: 'BOS',
      homeScore: 99,
      awayScore: 101,
      period: 4,
      clockSecs: 220,
      modelProb: 0.43,
      scheduledTipoff: tip('2026-11-25T00:00:00Z'),
      markets: [
        market({
          pubkey: 'Mkt3333333333333333333333333333333333333333',
          endTs: NOW + 130,
          price: 0.41,
        }),
      ],
    }),
    game({
      id: 'nba-401810004',
      home: 'PHX',
      away: 'DEN',
      status: 'scheduled',
      homeScore: 0,
      awayScore: 0,
      period: 0,
      clockSecs: null,
      modelProb: 0.44,
      scheduledTipoff: tip('2026-11-25T03:30:00Z'),
      markets: [],
    }),
    game({
      id: 'nba-401810005',
      home: 'SAC',
      away: 'LAL',
      status: 'scheduled',
      homeScore: 0,
      awayScore: 0,
      period: 0,
      clockSecs: null,
      modelProb: 0.52,
      scheduledTipoff: tip('2026-11-25T04:00:00Z'),
      markets: [],
    }),
  ]
}

/**
 * CLE's history from late in Q2: both teams score into Q3 (no run), then CLE goes on an 8-0
 * run in 2 minutes while the price moves 74 -> 77, then MEM answers.
 */
export function history(): GameHistory {
  const t = NOW - 900
  const snap = (dt: number, homeScore: number, awayScore: number, period = 3) => ({
    ts: t + dt,
    homeScore,
    awayScore,
    period,
    clockSecs: 300,
    modelProb: 0.7,
  })
  const pubkey = market().pubkey
  return {
    gameId: 'nba-401810001',
    snapshots: [
      snap(0, 74, 76, 2),
      snap(60, 76, 78),
      snap(120, 78, 78),
      snap(180, 81, 78),
      snap(240, 84, 78),
      snap(300, 84, 78),
      snap(400, 84, 80),
    ],
    prices: [
      { market: pubkey, ts: t + 100, price: 0.74 },
      { market: pubkey, ts: t + 240, price: 0.77 },
      { market: 'Other111111111111111111111111111111111111111', ts: t + 240, price: 0.1 },
    ],
  }
}

/** A buy of 25 mUSDC of CLE that moves the price from 77 to 79. */
export function quote(over: Partial<Quote> = {}): Quote {
  return {
    direction: 'usdcToYes',
    amountIn: '25',
    amountOut: '31.5',
    minOut: '30.87',
    feeUsdc: '0.5',
    avgPrice: 0.7778,
    priceBefore: 0.77,
    priceAfter: 0.79,
    priceImpactBps: 120,
    now: NOW,
    ...over,
  }
}

/**
 * My Game-day (R7): MEM (home, live against LAC) backed at 55%, now 62% with a 62% model at the
 * call; its market closes at 10:40 PM ET at the latest.
 */
export function mePosition(over: Partial<MePosition> = {}): MePosition {
  return {
    ...position({
      shares: '38.72',
      costUsdc: '20',
      valueUsdc: '24.0064',
      pnlUsdc: '4.0064',
      price: 0.62,
    }),
    team: 'MEM',
    avgPrice: 0.55,
    status: 'open',
    challengeEndsAt: null,
    call: { model: 0.62, result: null, points: null },
    ...over,
  }
}

export function meGame(over: Partial<MeGame> = {}): MeGame {
  return {
    game: game({
      home: 'MEM',
      away: 'LAC',
      modelProb: 0.62,
      markets: [market({ price: 0.62, endTs: at('2026-11-25T03:40:00Z') })],
    }),
    practice: false,
    positions: [mePosition()],
    ifHomeWins: { payoutUsdc: '38.72', netUsdc: '18.72' },
    ifAwayWins: { payoutUsdc: '0', netUsdc: '-20' },
    ...over,
  }
}

export function meResponse(over: Partial<MeResponse> = {}): MeResponse {
  return {
    wallet: WALLET,
    night: '2026-11-24',
    now: NOW,
    nights: 1,
    games: [meGame()],
    vsModel: { points: null, settled: 0, pending: 1, practicePoints: null },
    earlierClaimable: 0,
    nextGames: [],
    ...over,
  }
}
