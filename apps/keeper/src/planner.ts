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
  /**
   * A draft still unconfirmed this long after it could first be proposed alerts again (spec 7:
   * 30 min). That is the later of the draft and end_ts: a game halted at the buzzer drafts before
   * end_ts, and nobody can propose until end_ts.
   */
  missingSourceSecs: number
  /**
   * Auto-propose (R6) waits this long past the propose time for a second source that has not
   * answered (no final from balldontlie, or balldontlie down), then proposes unchecked.
   */
  secondSourceWaitSecs: number
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
  secondSourceWaitSecs: 600,
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
  /** The second source's verdict on the draft (R6); absent or null means none yet. */
  secondSource?: SecondSourceState | null
  /** Why the keeper's last auto-propose of this game did not land, if it failed. */
  proposeError?: string | null
}

export type AutoProposeMode = 'on' | 'dry' | 'off'

/**
 * balldontlie's verdict on the draft, and since when (unix seconds): `match` and `mismatch`
 * compare its final totals with the draft's, `pending` means no final from it yet, `off` that
 * the keeper has no second source.
 */
export type SecondSourceState =
  | { verdict: 'match' | 'pending' | 'off'; since: number }
  | { verdict: 'mismatch'; since: number; score: Score }

export interface Score {
  home: number
  away: number
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
  /**
   * The attestor proposes the pending Final draft (R6): `match` when the second source agrees,
   * `unchecked` when there is none (`off`) or it stayed silent (`pending`).
   */
  | {
      type: 'propose'
      gameId: string
      marketId: bigint
      check: 'match' | 'unchecked'
      reason: 'match' | 'off' | 'pending'
    }
  /** The second source contradicts the draft: nothing is proposed, a guardian is paged. */
  | { type: 'hold'; gameId: string; espn: Score; second: Score }
  /** The second source contradicts a proposal still open to challenge. */
  | { type: 'mismatch'; gameId: string; proposed: Score; second: Score; challengeBy: number }

export interface PlanInput {
  now: number
  states: readonly GameState[]
  timings: Timings
  seeds: SeedPolicy
  /** From the on-chain Config. */
  disputeWindowSecs: number
  /** Auto-propose (R6); absent means off. */
  autoPropose?: AutoProposeMode
}

const ORDER: Record<Action['type'], number> = {
  halt: 0,
  sync: 1,
  finalize: 2,
  recycle: 3,
  propose: 4,
  create: 5,
  draft: 6,
  hold: 7,
  mismatch: 8,
  alert: 9,
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
    } else if (draft.state === 'pending') {
      const auto = autoPropose(s, draft, chain, input)
      if (auto) out.push(auto)
      // The keeper proposing this tick is not reminded of, unless its last try failed (or the
      // mode is dry, where nothing is sent).
      const proposing = auto?.type === 'propose' && input.autoPropose === 'on' && !s.proposeError
      if (
        !proposing &&
        !draft.alertedAt &&
        now - Math.max(Math.floor(draft.fetchedAt.getTime() / 1000), chain.endTs) >=
          t.missingSourceSecs
      ) {
        out.push({
          type: 'alert',
          gameId: g.id,
          key: `unconfirmed:${g.id}`,
          text: unconfirmedText(s, draft, chain, input),
        })
      }
    }
  }

  const second = s.secondSource
  if (
    (input.autoPropose ?? 'off') !== 'off' &&
    chain.status === 'proposed' &&
    now < chain.proposedAt + input.disputeWindowSecs &&
    s.draft?.state === 'proposed' &&
    second?.verdict === 'mismatch'
  ) {
    out.push({
      type: 'mismatch',
      gameId: g.id,
      proposed: { home: s.draft.homeScore, away: s.draft.awayScore },
      second: second.score,
      challengeBy: chain.proposedAt + input.disputeWindowSecs,
    })
  }

  if (chain.status === 'proposed' && now >= chain.proposedAt + input.disputeWindowSecs) {
    out.push({ type: 'finalize', gameId: g.id, marketId })
  }
  if (chain.status === 'finalized') out.push({ type: 'recycle', gameId: g.id, marketId })
  return out
}

/**
 * Why the keeper leaves this pending draft to a guardian, or null when it may propose it: a
 * postponed result, a round after a challenge, another league, or a feed that no longer holds
 * a consistent Final at the draft's score (spec 7 gives those to a person).
 */
function autoBlock(s: GameState, draft: DraftRow, chain: GameMarketAccount): string | null {
  if (draft.status !== 'final') return 'a postponed result is proposed by hand'
  if (chain.challengeCount > 0 || chain.status === 'challenged')
    return 'after a challenge a guardian proposes'
  if (s.game.league !== 'NBA') return 'auto-propose covers NBA games only'
  const feed = s.feed
  const atDraft =
    feed?.status === 'final' &&
    feed.homeScore === draft.homeScore &&
    feed.awayScore === draft.awayScore &&
    periodsConsistent(feed)
  if (!atDraft || s.finalSince === null)
    return 'ESPN no longer shows a consistent Final at the draft score'
  return null
}

/**
 * The propose (or the hold) for a pending Final draft, from the later of Final held
 * finalStableSecs and end_ts; a silent second source gets secondSourceWaitSecs more.
 */
function autoPropose(
  s: GameState,
  draft: DraftRow,
  chain: GameMarketAccount,
  input: PlanInput,
): Action | null {
  if ((input.autoPropose ?? 'off') === 'off') return null
  if (chain.status !== 'open' && chain.status !== 'halted') return null
  if (autoBlock(s, draft, chain) !== null || s.finalSince === null) return null
  const { now, timings: t } = input
  const from = Math.max(s.finalSince + t.finalStableSecs, chain.endTs)
  if (now < from) return null
  const g = s.game
  const marketId = chain.marketId
  const second = s.secondSource ?? null
  switch (second?.verdict) {
    case 'match':
      return { type: 'propose', gameId: g.id, marketId, check: 'match', reason: 'match' }
    case 'off':
      return { type: 'propose', gameId: g.id, marketId, check: 'unchecked', reason: 'off' }
    case 'mismatch':
      return {
        type: 'hold',
        gameId: g.id,
        espn: { home: draft.homeScore, away: draft.awayScore },
        second: second.score,
      }
    default:
      if (now < from + t.secondSourceWaitSecs) return null
      return { type: 'propose', gameId: g.id, marketId, check: 'unchecked', reason: 'pending' }
  }
}

/** The 30-min reminder: with auto-propose on or dry, why nothing was proposed, and the command. */
function unconfirmedText(
  s: GameState,
  draft: DraftRow,
  chain: GameMarketAccount,
  input: PlanInput,
): string {
  const g = s.game
  const name = `${g.away}@${g.home}`
  const mode = input.autoPropose ?? 'off'
  if (mode === 'off')
    return `${name}: ${draft.status} draft open to propose for 30 min, waiting for the guardian's box-score check`
  const second = s.secondSource
  const cause =
    mode === 'dry'
      ? 'auto-propose is a dry run'
      : (autoBlock(s, draft, chain) ??
        (second?.verdict === 'mismatch'
          ? `held: ESPN ${draft.awayScore}-${draft.homeScore} vs balldontlie ${second.score.away}-${second.score.home}`
          : s.proposeError
            ? `auto-propose failing: ${s.proposeError}`
            : 'cause unknown, see the keeper log'))
  const args =
    draft.status === 'final'
      ? `--box-score <url> --score ${draft.homeScore}-${draft.awayScore}`
      : '--postponed --notice <url>'
  return `${name}: ${draft.status} draft not proposed 30 min after proposing opened: ${cause}. Propose by hand: horagon-ops propose ${g.id} ${args}`
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
  // end_ts is only the latest close: a game read Final is halted at the buzzer long before it.
  const halt = `If the game may end before end_ts: horagon-ops halt ${g.id}`
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
  const closes = `end_ts in ${Math.ceil((chain.endTs - now) / 60)} min, and this alert does not halt the market`
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
