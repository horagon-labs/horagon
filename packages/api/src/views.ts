// DB rows -> API v1 shapes (the zod schemas in @horagon/sdk/schemas). Pure functions.
import type { GameWithMarkets, MarketRow, SnapshotRow } from '@horagon/db'
import {
  etDayRange,
  etNextDay,
  etNight,
  etToday,
  formatAmount,
  type Game,
  type GameActivity,
  type GameDetail,
  type GameHistory,
  type GameStatus,
  type MarketStatus,
  type MarketSummary,
  marketKindName,
  type Outcome,
  type Resolution,
} from '@horagon/sdk'
import { challengeEndsAt } from './dispute-window'

const secs = (d: Date) => Math.floor(d.getTime() / 1000)

export type PriceIndex = Map<string, { price: number; ts: Date }>

export function toMarketSummary(m: MarketRow, prices: PriceIndex): MarketSummary {
  const p = prices.get(m.pubkey)
  return {
    pubkey: m.pubkey,
    kind: marketKindName(m.kind),
    status: m.status as MarketStatus,
    endTs: secs(m.endTs),
    initialPriceBps: m.initialPriceBps,
    seedUsdc: formatAmount(m.seedAmount),
    price: p ? p.price : null,
    priceTs: p ? secs(p.ts) : null,
    outcome: (m.outcome as Outcome | null) ?? null,
  }
}

export function toGame(g: GameWithMarkets, prices: PriceIndex): Game {
  return {
    id: g.id,
    league: g.league,
    home: g.home,
    away: g.away,
    scheduledTipoff: g.scheduledTipoff.toISOString(),
    status: g.status as GameStatus,
    homeScore: g.homeScore,
    awayScore: g.awayScore,
    period: g.period,
    clockSecs: g.status === 'live' ? g.clockSecs : null,
    featured: g.featured,
    modelProb: g.status === 'scheduled' ? g.p0 : (g.modelProb ?? g.p0),
    markets: g.markets.map((m) => toMarketSummary(m, prices)),
    updatedAt: g.updatedAt.toISOString(),
  }
}

/** Spec section 6.2, as shown under "Market rules" on the game page. */
export function marketRules(g: Pick<GameWithMarkets, 'home' | 'away'>, kinds: number[]): string[] {
  const rules: string[] = []
  if (kinds.includes(0)) {
    rules.push(
      `Winner market: YES if ${g.home} (home) wins, overtime included. Buy ${g.away} = buy NO.`,
    )
  }
  if (kinds.includes(1)) {
    rules.push(
      `Second-half market: YES if ${g.home} scores more points than ${g.away} in Q3 + Q4, overtime excluded. A tie resolves NO.`,
    )
  }
  rules.push(
    'A market closes at the final buzzer (the keeper halts it on the first Final read), or 3 hours after the scheduled tip-off at the latest. It also halts if it has not started 24 hours after the scheduled tip-off, if it is postponed or canceled, or if every score feed goes silent for more than 10 minutes in Q4 or overtime.',
    'A guardian can also halt a market by hand, for example when the score feed is down near the close or shows something wrong. A halt cannot be undone.',
    'Postponed games: a makeup game within 7 days of the scheduled tip-off decides the market; otherwise it resolves NO. Redeeming a YES + NO pair for 1 mUSDC works at any time.',
    'Results are proposed with public evidence and can be challenged by a guardian for 15 minutes before they become final. Play money on devnet: no real value, no prizes.',
  )
  return rules
}

export function toResolution(
  m: MarketRow,
  publicUrl: string,
  disputeWindowSecs: number | null,
): Resolution {
  const kind = marketKindName(m.kind)
  return {
    market: m.pubkey,
    kind,
    status: m.status as MarketStatus,
    outcome: (m.outcome as Outcome | null) ?? null,
    evidenceHash: m.evidenceHash,
    evidenceUrl: m.evidenceHash ? `${publicUrl}/api/v1/evidence/${m.gameId}/${kind}` : null,
    createSig: m.createSig,
    haltSig: m.haltSig,
    proposeSig: m.proposeSig,
    finalizeSig: m.finalizeSig,
    recycleSig: m.recycleSig,
    externalLp: m.externalLp,
    gameMarket: m.gameMarketPda,
    proposedAt: m.proposedAt ? secs(m.proposedAt) : null,
    challengeEndsAt: challengeEndsAt(m.status, m.proposedAt, disputeWindowSecs),
  }
}

export function toGameDetail(
  g: GameWithMarkets,
  prices: PriceIndex,
  publicUrl: string,
  activity: GameActivity,
  disputeWindowSecs: number | null,
): GameDetail {
  return {
    ...toGame(g, prices),
    rules: marketRules(
      g,
      g.markets.map((m) => m.kind),
    ),
    resolutions: g.markets.map((m) => toResolution(m, publicUrl, disputeWindowSecs)),
    activity,
  }
}

export function toHistory(
  gameId: string,
  snapshots: SnapshotRow[],
  prices: Array<{ market: string; ts: Date; price: number }>,
): GameHistory {
  return {
    gameId,
    snapshots: snapshots.map((s) => ({
      ts: secs(s.ts),
      homeScore: s.homeScore,
      awayScore: s.awayScore,
      period: s.period,
      clockSecs: s.clockSecs,
      modelProb: s.modelProb,
    })),
    prices: prices.map((p) => ({ market: p.market, ts: secs(p.ts), price: p.price })),
  }
}

export { etDayRange, etNextDay, etNight, etToday }
