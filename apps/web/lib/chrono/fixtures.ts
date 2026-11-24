// Sample games for the tests and the dev-only state gallery (app/dev/chrono): one evening at
// 9:08 PM ET with a game minutes from its close, two live games and two not open yet.
import type { Game, GameDetail, MarketSummary, Position, PositionsResponse } from '@horagon/sdk'

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
