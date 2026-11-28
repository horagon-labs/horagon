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

/**
 * A span in words: "3 hours", "2 h 10 min", "30 minutes", "15 minutes", "45 seconds". Used for a
 * market's latest close after tip-off and for the challenge window.
 */
export function spanWords(secs: number): string {
  const s = Math.max(0, Math.round(secs))
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`
  if (s % 86_400 === 0 && s > 0) return plural(s / 86_400, 'day')
  if (s % 3_600 === 0 && s > 0) return plural(s / 3_600, 'hour')
  if (s % 60 === 0 && s > 0) {
    return s < 3_600
      ? plural(s / 60, 'minute')
      : `${Math.floor(s / 3_600)} h ${(s % 3_600) / 60} min`
  }
  if (s < 60) return plural(s, 'second')
  return `${Math.floor(s / 60)} min ${s % 60} s`
}

/** The fields of a market its close rule is read from. */
export type RuleMarket = Pick<MarketRow, 'kind' | 'status' | 'endTs' | 'haltSig'>

/**
 * When this game's market closes, from the market's own end_ts and halt (never a constant: the
 * shakedown markets of ET 2026-11-24 and 11-25 ended 2 h 10 min after tip-off and were never
 * halted; today's end 3 h after it). The winner market speaks for the game. A market past
 * trading (a result proposed or later) with no halt traded until its end_ts.
 */
export function closeRule(
  g: Pick<GameWithMarkets, 'scheduledTipoff'>,
  market: RuleMarket | undefined,
): string {
  if (!market) {
    return 'A market closes at the final buzzer (the keeper halts it on the first Final read), or at the latest at the end time the keeper sets when it creates the market.'
  }
  const after = spanWords(secs(market.endTs) - secs(g.scheduledTipoff))
  if (market.haltSig) {
    return `This market closed with a halt, before its latest close ${after} after the scheduled tip-off.`
  }
  if (market.status !== 'open' && market.status !== 'halted') {
    return `This market closed at its end time, ${after} after the scheduled tip-off: it was never halted, so it did not close at the final buzzer.`
  }
  return `A market closes at the final buzzer (the keeper halts it on the first Final read), or ${after} after the scheduled tip-off at the latest.`
}

/**
 * The challenge window as the program's Config sets it today (`disputeWindowSecs`, null when
 * unread): the admin key can change it, from 60 s to 7 days, so it is never stated as fixed.
 */
export function challengeRule(disputeWindowSecs: number | null): string {
  const span =
    disputeWindowSecs === null
      ? 'during the challenge window'
      : `for ${spanWords(disputeWindowSecs)}`
  return `Results are proposed with public evidence and can be challenged by a guardian ${span} before they become final. The window is a setting in the program's Config that the admin key can change, from 60 s to 7 days. Play money on devnet: no real value, no prizes.`
}

/** Spec section 6.2, as shown under "Market rules" on the game page. */
export function marketRules(
  g: Pick<GameWithMarkets, 'home' | 'away' | 'scheduledTipoff'>,
  markets: readonly RuleMarket[],
  disputeWindowSecs: number | null,
): string[] {
  const rules: string[] = []
  const kinds = markets.map((m) => m.kind)
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
    `${closeRule(g, markets.find((m) => m.kind === 0) ?? markets[0])} The keeper also halts a market if it has not started 24 hours after the scheduled tip-off, if it is postponed or canceled, or if every score feed goes silent for more than 10 minutes in Q4 or overtime.`,
    'A guardian can also halt a market by hand, for example when the score feed is down near the close or shows something wrong. A halt cannot be undone.',
    'Postponed games: a makeup game within 7 days of the scheduled tip-off decides the market; otherwise it resolves NO. Redeeming a YES + NO pair for 1 mUSDC works at any time.',
    challengeRule(disputeWindowSecs),
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
    rules: marketRules(g, g.markets, disputeWindowSecs),
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
