// The keeper's decisions, as a pure function of what it can observe (spec 7: "the keeper holds
// no state of its own; each tick it derives what to do from the on-chain GameMarket, the games
// table and the feed"). No I/O here: `tick.ts` gathers the inputs and performs the actions,
// each of which re-checks chain state before sending, so a repeated action is harmless.
import type { DraftRow, GameRow, MarketRow } from '@horagon/db'
import type { GameMarketAccount } from '@horagon/sdk'
import { type FeedGame, periodsConsistent } from './feeds/types'

export interface Timings {
  /** Create the winner market this long before the scheduled tip-off (spec 6.1: S - 60 min). */
  createLeadSecs: number
  /**
   * end_ts, this long after the scheduled tip-off: the latest a market can trade (S + 3h00m).
   * The real close is the final buzzer: a Final read before end_ts halts the market
   * (`final-before-end`). Over 268 games of 2026-10-20 to 2026-11-25, 5 (1.9%) were still being
   * played at S + 3h00m and closed early; at S + 2h55m it was 16 (6%). S + 2h10m, the close
   * until 2026-11-26, came with a median 7.2 of Q4's 12 game minutes left (spikes end-ts).
   */
  endOffsetSecs: number
  /** A game still not live this long after S is skipped instead of created late. */
  createGraceSecs: number
  /** Final, with the same score, for at least this long before a draft (spec 6.1: >= 60 s). */
  finalStableSecs: number
  /**
   * No feed for this long before end_ts alerts the guardian (spec 6.2: 2 min): in Q4 or OT at any
   * time, and in any period during the last feedSilentWatchSecs.
   */
  feedSilentAlertSecs: number
  /**
   * No feed for this long in Q4 or OT before end_ts halts the market (spec 6.2: 10 min). A halt
   * cannot be undone and the market trades through Q4 (a median 33 wall minutes), so a short
   * ESPN outage only alerts.
   */
  feedSilentSecs: number
  /**
   * From this long before end_ts, no feed for feedSilentAlertSecs alerts whatever the feed last
   * showed, and a game not read since the keeper started alerts at once, its silence being unknown
   * (spec 6.2: from S + 1h40m, so endOffsetSecs - 6,000). The keeper knows the quarter only from
   * the feed: an outage that starts in Q3 and runs into Q4 never meets the Q4 rule, so the watch
   * must start before any game reaches Q4. Over 268 games, Q4 began at S + 102.7 min at the
   * earliest. This alert never halts.
   */
  feedSilentWatchSecs: number
  /** Not started this long after S halts the market (spec 6.2: S + 24h). */
  notStartedSecs: number
  /** A postponed game not made up within this long resolves NO (spec 6.2: 7 days). */
  postponedResolveSecs: number
  /** A draft still unconfirmed this long after Final alerts again (spec 7: 30 min). */
  missingSourceSecs: number
}

export const DEFAULT_TIMINGS: Timings = {
  createLeadSecs: 3_600,
  endOffsetSecs: 10_800,
  createGraceSecs: 1_800,
  finalStableSecs: 60,
  feedSilentAlertSecs: 120,
  feedSilentSecs: 600,
  feedSilentWatchSecs: 4_800,
  notStartedSecs: 86_400,
  postponedResolveSecs: 7 * 86_400,
  missingSourceSecs: 1_800,
}

/** Must match the program's MIN_MARKET_SECS. */
export const MIN_MARKET_SECS = 300
export const MIN_PRICE_BPS = 500
export const MAX_PRICE_BPS = 9_500

export interface SeedPolicy {
  featured: bigint
  regular: bigint
}
/** Spec 6.3: 1,000 mUSDC for a featured game, 300 otherwise (6 decimals). */
export const DEFAULT_SEEDS: SeedPolicy = { featured: 1_000_000_000n, regular: 300_000_000n }

/** What the keeper knows about one game this tick. */
export interface GameState {
  game: GameRow
  /** The DB row of the winner market (kind 0), if one was created. */
  market: MarketRow | null
  /** The GameMarket account behind `market`, read this tick; null if the row has none yet. */
  onchain: GameMarketAccount | null
  /** Latest feed observation, possibly stale; null if the feed never returned this game. */
  feed: FeedGame | null
  /** Unix seconds of the last successful feed read that included this game. */
  feedSeenAt: number | null
  /** Unix seconds since the feed has reported Final with the current score, unbroken. */
  finalSince: number | null
  draft: DraftRow | null
}

export type HaltRule = 'final-before-end' | 'postponed' | 'not-started' | 'feed-silent'

export type Action =
  | {
      type: 'create'
      gameId: string
      kind: 0
      initialPriceBps: number
      endTs: number
      seedAmount: bigint
      featured: boolean
    }
  | { type: 'halt'; gameId: string; marketId: bigint; rule: HaltRule }
  | {
      type: 'draft'
      gameId: string
      status: 'final' | 'postponed'
      homeScore: number
      awayScore: number
      periods: Array<[number, number]>
    }
  | { type: 'finalize'; gameId: string; marketId: bigint }
  | { type: 'recycle'; gameId: string; marketId: bigint }
  /** Copy the on-chain status into the DB row, so the API shows it. */
  | { type: 'sync'; gameId: string; marketId: bigint }
  | { type: 'alert'; gameId: string; key: string; text: string }

export interface PlanInput {
  now: number
  states: readonly GameState[]
  timings: Timings
  seeds: SeedPolicy
  /** From the on-chain Config. */
  disputeWindowSecs: number
}

const ORDER: Record<Action['type'], number> = {
  halt: 0,
  sync: 1,
  finalize: 2,
  recycle: 3,
  create: 4,
  draft: 5,
  alert: 6,
}

export function priceBps(p0: number): number {
  return Math.min(MAX_PRICE_BPS, Math.max(MIN_PRICE_BPS, Math.round(p0 * 10_000)))
}

function periodsAlert(s: GameState, feed: FeedGame): Action {
  const g = s.game
  return {
    type: 'alert',
    gameId: g.id,
    key: `periods:${g.id}`,
    text: `${g.away}@${g.home}: ESPN periods do not add up to ${feed.homeScore}-${feed.awayScore}; resolve by hand`,
  }
}

function planGame(s: GameState, input: PlanInput): Action[] {
  const { now, timings: t } = input
  const g = s.game
  const tip = Math.floor(g.scheduledTipoff.getTime() / 1000)
  const feed = s.feed
  const out: Action[] = []

  if (!s.market) {
    const notStarted = !feed || feed.status === 'scheduled'
    const endTs = tip + t.endOffsetSecs
    if (
      g.status === 'scheduled' &&
      notStarted &&
      now >= tip - t.createLeadSecs &&
      now < tip + t.createGraceSecs &&
      endTs - now >= MIN_MARKET_SECS
    ) {
      if (g.p0 === null || !Number.isFinite(g.p0)) {
        out.push({
          type: 'alert',
          gameId: g.id,
          key: `no-p0:${g.id}`,
          text: `${g.away}@${g.home}: no p0, market not created`,
        })
      } else {
        out.push({
          type: 'create',
          gameId: g.id,
          kind: 0,
          initialPriceBps: priceBps(g.p0),
          endTs,
          seedAmount: g.featured ? input.seeds.featured : input.seeds.regular,
          featured: g.featured,
        })
      }
    }
    return out
  }

  const chain = s.onchain
  if (!chain) return out
  const marketId = chain.marketId
  if (s.market.status !== chain.status) out.push({ type: 'sync', gameId: g.id, marketId })

  // The tip-off recorded on chain, not the DB row: a makeup date moves the row, but the 24 h
  // and 7 day windows of spec 6.2 count from the original schedule.
  const chainTip = chain.scheduledTipoff
  if (chain.status === 'open') {
    const rule = haltRule(s, chain, now, t, chainTip)
    if (rule) out.push({ type: 'halt', gameId: g.id, marketId, rule })
    else {
      const silence = silenceAlert(s, chain, now, t)
      if (silence) out.push({ type: 'alert', gameId: g.id, ...silence })
    }
  }

  // A challenge rejects the draft: the keeper drafts again from the feed (or the guardian
  // proposes with corrected periods).
  const draft = s.draft?.state === 'rejected' ? null : s.draft
  if (chain.status === 'open' || chain.status === 'halted' || chain.status === 'challenged') {
    if (!draft) {
      const next = draftFor(s, now, t, chainTip)
      if (next) out.push(next)
      else out.push(...draftBlocked(s, now, t, chainTip))
    } else if (draft.state === 'pending' && scoreCorrected(s)) {
      // ESPN corrected the Final score after the draft (a stat correction): draft again once
      // the new score is stable, so the guardian confirms that one. A proposed draft stays.
      const again = draftFor(s, now, t, chainTip)
      if (again) out.push(again)
      else {
        // A corrected score that does not add up (or is tied) must not leave the old draft
        // to be confirmed unwarned.
        out.push(...draftBlocked(s, now, t, chainTip))
      }
    } else if (
      draft.state === 'pending' &&
      !draft.alertedAt &&
      now - Math.floor(draft.fetchedAt.getTime() / 1000) >= t.missingSourceSecs
    ) {
      out.push({
        type: 'alert',
        gameId: g.id,
        key: `unconfirmed:${g.id}`,
        text: `${g.away}@${g.home}: ${draft.status} draft waiting 30 min for the guardian's box-score check`,
      })
    }
  }

  if (chain.status === 'proposed' && now >= chain.proposedAt + input.disputeWindowSecs) {
    out.push({ type: 'finalize', gameId: g.id, marketId })
  }
  if (chain.status === 'finalized') out.push({ type: 'recycle', gameId: g.id, marketId })
  return out
}

function haltRule(
  s: GameState,
  chain: GameMarketAccount,
  now: number,
  t: Timings,
  tip: number,
): HaltRule | null {
  const feed = s.feed
  if (feed?.status === 'final' && now < chain.endTs) return 'final-before-end'
  if (feed?.status === 'postponed' || feed?.status === 'canceled') return 'postponed'
  if (now >= tip + t.notStartedSecs && (!feed || feed.status === 'scheduled')) return 'not-started'
  const silent = q4Silence(s, chain, now)
  if (silent !== null && silent > t.feedSilentSecs) return 'feed-silent'
  return null
}

/** Seconds without a feed read for a live Q4 or OT game whose market still trades, else null. */
function q4Silence(s: GameState, chain: GameMarketAccount, now: number): number | null {
  const feed = s.feed
  if (feed?.status !== 'live' || feed.period < 4) return null
  if (s.feedSeenAt === null || now >= chain.endTs) return null
  return now - s.feedSeenAt
}

/**
 * The guardian's alert text for a silent feed while the market trades (spec 6.2), or null. In Q4
 * or OT it comes after feedSilentAlertSecs, ahead of the halt at feedSilentSecs. In the last
 * feedSilentWatchSecs before end_ts it comes whatever the feed last showed: a quarter before Q4,
 * the pre-game listing, or nothing since the keeper started. It never halts by itself.
 */
function silenceAlert(
  s: GameState,
  chain: GameMarketAccount,
  now: number,
  t: Timings,
): { key: string; text: string } | null {
  const { game: g, feed } = s
  if (now >= chain.endTs) return null
  if (feed && feed.status !== 'scheduled' && feed.status !== 'live') return null
  const name = `${g.away}@${g.home}`
  const key = `feed-silent:${g.id}`
  const halt = `If the game may end before the close: horagon-ops halt ${g.id}`
  const q4 = q4Silence(s, chain, now)
  if (q4 !== null) {
    if (q4 <= t.feedSilentAlertSecs) return null
    // Its own key: the watch-window alert must not hide this pre-halt warning from the alerter.
    return {
      key: `feed-silent-q4:${g.id}`,
      text: `${name}: no feed for ${Math.floor(q4 / 60)} min in Q4/OT, market still open; the keeper halts at ${Math.round(t.feedSilentSecs / 60)} min. ${halt}`,
    }
  }
  if (now < chain.endTs - t.feedSilentWatchSecs) return null
  const closes = `the market closes in ${Math.ceil((chain.endTs - now) / 60)} min and this alert does not halt it`
  if (!feed || s.feedSeenAt === null) {
    return { key, text: `${name}: no feed read since the keeper started; ${closes}. ${halt}` }
  }
  const silent = now - s.feedSeenAt
  if (silent <= t.feedSilentAlertSecs) return null
  const last = feed.status === 'live' && feed.period > 0 ? `in Q${feed.period}` : 'before tip-off'
  return {
    key,
    text: `${name}: no feed for ${Math.floor(silent / 60)} min, last seen ${last}; ${closes}. ${halt}`,
  }
}

/** Why no draft came out of draftFor, as alerts: bad data the guardian must resolve by hand. */
function draftBlocked(s: GameState, now: number, t: Timings, tip: number): Action[] {
  const { feed, game: g } = s
  const name = `${g.away}@${g.home}`
  if (feed?.status === 'final') {
    if (feed.homeScore === feed.awayScore) {
      return [
        {
          type: 'alert',
          gameId: g.id,
          key: `tie:${g.id}`,
          text: `${name}: ESPN Final is tied ${feed.homeScore}-${feed.awayScore}; resolve by hand`,
        },
      ]
    }
    if (!periodsConsistent(feed)) return [periodsAlert(s, feed)]
    return []
  }
  if (!feed && now >= tip + t.postponedResolveSecs) {
    return [
      {
        type: 'alert',
        gameId: g.id,
        key: `no-feed:${g.id}`,
        text: `${name}: no feed 7 days after tip-off; resolve by hand`,
      },
    ]
  }
  return []
}

function scoreCorrected(s: GameState): boolean {
  const { draft, feed } = s
  return (
    draft?.status === 'final' &&
    feed?.status === 'final' &&
    (feed.homeScore !== draft.homeScore || feed.awayScore !== draft.awayScore)
  )
}

function draftFor(s: GameState, now: number, t: Timings, tip: number): Action | null {
  const feed = s.feed
  if (
    feed?.status === 'final' &&
    s.finalSince !== null &&
    now - s.finalSince >= t.finalStableSecs &&
    feed.homeScore !== feed.awayScore &&
    periodsConsistent(feed)
  ) {
    return {
      type: 'draft',
      gameId: s.game.id,
      status: 'final',
      homeScore: feed.homeScore,
      awayScore: feed.awayScore,
      periods: feed.periods,
    }
  }
  // NO needs positive evidence: a feed that says the game was not played. A missing feed
  // (an outage, a restart) is not evidence, and alerts instead (draftBlocked).
  const notPlayed =
    feed !== null &&
    (feed.status === 'scheduled' || feed.status === 'postponed' || feed.status === 'canceled')
  if (notPlayed && now >= tip + t.postponedResolveSecs) {
    return {
      type: 'draft',
      gameId: s.game.id,
      status: 'postponed',
      homeScore: 0,
      awayScore: 0,
      periods: [],
    }
  }
  return null
}

/** Every action for this tick, halts first (spec 6.2: halt goes out with a high priority fee). */
export function plan(input: PlanInput): Action[] {
  return input.states
    .flatMap((s) => planGame(s, input))
    .sort((a, b) => ORDER[a.type] - ORDER[b.type])
}
