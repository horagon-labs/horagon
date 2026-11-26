// One keeper tick (spec 7, every 5 s): read the feed, refresh live game rows and the model
// probability, read every GameMarket on chain, plan, then perform each action. An action that
// fails is logged and retried on a later tick; it never stops the others. With auto-propose
// (R6), the attestor also proposes checked Final results, asks balldontlie for its own final, and
// pages a guardian whenever the two sources disagree or no second source answered.
import {
  type Db,
  type GameRow,
  type GameWithMarkets,
  getDraft,
  getEvidence,
  getHeartbeat,
  heartbeat,
  insertSnapshot,
  listGames,
  logOps,
  setDraftState,
  updateGameLive,
  updateMarket,
  upsertDraft,
  upsertMarket,
} from '@horagon/db'
import {
  CREATE_MARKET_COMPUTE_UNITS,
  decodeGameMarket,
  deriveGameMarket,
  errorSummary,
  type GameMarketAccount,
  HEAVY_IX_COMPUTE_UNITS,
  type HoragonProgram,
  marketIdFor,
  marketName,
  outcomeFor,
  parseResolutionEvidence,
  winProbability,
} from '@horagon/sdk'
import { toHex } from '@horagon/sdk/evidence'
import type { Keypair } from '@solana/web3.js'
import type { Logger } from 'pino'
import { z } from 'zod'
import type { Alerter } from './alerts'
import type { AutoProposeConfig } from './config'
import { ProgramFailure, type TxSender } from './executor'
import { espnScoreboardUrl } from './feeds/espn'
import { type Feed, type FeedGame, gameIdOf } from './feeds/types'
import {
  type Action,
  type GameState,
  plan,
  type Score,
  type SecondSourceState,
  type SeedPolicy,
  type Timings,
} from './planner'
import { type ConfirmSource, type ProposeOutcome, proposeResult } from './propose'
import {
  BdlError,
  bdlGameUrl,
  type DateGames,
  findGame,
  secondGame,
} from './second-source/balldontlie'
import { type Verdict, verdictOf } from './second-source/check'
import { isMissingAccount } from './treasury'

/** A second source: one ET date's games, or null when that date is not due yet. */
export interface SecondSource {
  games(etDate: string, now: number): Promise<DateGames | null>
}

/** Auto-propose (R6), on or dry. Absent from KeeperDeps, the keeper never proposes. */
export interface AutoProposeDeps {
  mode: 'on' | 'dry'
  /** `evidenceUri` of the game, from HORAGON_PUBLIC_URL. */
  evidenceUri: (gameId: string) => string
  /** balldontlie; null without BALLDONTLIE_API_KEY (the verdict is then `off`). */
  secondSource: SecondSource | null
}

export interface KeeperDeps {
  db: Db
  sender: TxSender
  program: HoragonProgram
  attestor: Keypair
  feed: Feed
  alerts: Alerter
  log: Logger
  /** Unix seconds. */
  now: () => number
  timings: Timings
  seeds: SeedPolicy
  /** Brownian model sigma, from data/elo.json. */
  sigma: number
  priority: { normal: number; halt: number }
  /** ESPN is read at most this often (spec 6.1: every 15 s). */
  feedEverySecs?: number
  /** Auto-propose (R6); absent means off. */
  autoPropose?: AutoProposeDeps
}

/** One second-source check of a game's draft, kept in memory like `Keeper.observed`. */
interface Check {
  verdict: Verdict
  /** Unix seconds since this verdict holds for this draft score. */
  since: number
  /** The draft score it was checked against (home-away). */
  draft: Score
  /** The second source's final totals, when it had them. */
  second: Score | null
  /** balldontlie's game id: `sources[1]` of a checked proposal. */
  bdlId: number | null
  /** When that answer was read (unix seconds). */
  fetchedAt: number
}

const sameScore = (a: Score, b: Score) => a.home === b.home && a.away === b.away

/** `keeper_heartbeats.process` of a game's held result, which a restart must not forget. */
export const heldRecordKey = (gameId: string) => `second-source:${gameId}`

const ScoreSchema = z.object({ home: z.number().int(), away: z.number().int() })
/** The held result: balldontlie's contradicting final, or null once it agreed with the draft. */
const HeldRecordSchema = z.object({
  draft: ScoreSchema,
  second: ScoreSchema.nullable(),
  since: z.number(),
})

interface Observed {
  game: FeedGame
  seenAt: number
  finalSince: number | null
  url: string
}

/** Minutes left for the model: regulation counts down from 48, overtime from 5 per period. */
export function minutesRemaining(g: Pick<FeedGame, 'status' | 'period' | 'clockSecs'>): number {
  if (g.status === 'final') return 0
  if (g.status !== 'live' || g.period === 0) return 48
  const clock = (g.clockSecs ?? 0) / 60
  return g.period <= 4 ? Math.min(48, (4 - g.period) * 12 + clock) : Math.min(5, clock)
}

export function modelProbability(g: FeedGame, p0: number | null, sigma: number): number | null {
  if (p0 === null || !(p0 > 0 && p0 < 1)) return null
  try {
    return winProbability({
      margin: g.homeScore - g.awayScore,
      minutesRemaining: minutesRemaining(g),
      p0,
      sigma,
    })
  } catch {
    return null
  }
}

const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
const ET_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

/** `2026-11-28 02:00 UTC (9:00 PM ET)`: a time in UTC, and the same time in ET. */
export function utcAndEt(unixSecs: number): string {
  const d = new Date(unixSecs * 1000)
  const part = (type: string) => ET_TIME.formatToParts(d).find((p) => p.type === type)?.value
  const utc = d.toISOString().slice(0, 16).replace('T', ' ')
  return `${utc} UTC (${part('hour')}:${part('minute')} ${part('dayPeriod')} ET)`
}

/**
 * The `draft:` text. A Final draft comes about 60 s after the buzzer, before `end_ts` as a rule,
 * and `horagon-ops propose` refuses until `end_ts`: so the text says when proposing opens,
 * rather than asking for a propose now. A draft at or after `end_ts` (overtime past it, a
 * postponed game) can be proposed at once.
 */
export function draftText(
  g: Pick<GameRow, 'id' | 'away' | 'home'>,
  a: { status: 'final' | 'postponed'; homeScore: number; awayScore: number },
  endTs: number | null,
  now: number,
  /**
   * Set when the keeper will propose this draft itself (auto-propose on, a Final, round 0, NBA):
   * from when (max(Final held 60 s, end_ts)) and with which second source.
   */
  auto: { from: number; secondSource: 'balldontlie' | 'off' } | null = null,
): string {
  if (auto && a.status === 'final') {
    return (
      `${g.away}@${g.home} Final ${a.awayScore}-${a.homeScore} (ESPN). Auto-propose from ` +
      `${utcAndEt(auto.from)}, second source ${auto.secondSource}. Nothing to do unless paged.`
    )
  }
  if (a.status === 'postponed') {
    return (
      `${g.away}@${g.home} was not played within 7 days. Resolve NO:\n` +
      `horagon-ops propose ${g.id} --postponed --notice <url>`
    )
  }
  const when =
    endTs !== null && now < endTs
      ? `Check the box score; proposing opens at ${utcAndEt(endTs)}, then run:`
      : 'Check the box score, then run:'
  return (
    `${g.away}@${g.home} Final ${a.awayScore}-${a.homeScore} (ESPN). ${when}\n` +
    `horagon-ops propose ${g.id} --box-score <url> --score ${a.homeScore}-${a.awayScore}`
  )
}

/** basketball-reference spells three home teams its own way. */
const BOX_SCORE_CODES: Readonly<Record<string, string>> = { BKN: 'BRK', CHA: 'CHO', PHX: 'PHO' }

/** The box score a guardian checks by hand: a link for a person, never fetched by the keeper. */
export function boxScoreLink(g: Pick<GameRow, 'gameDate' | 'home'>): string {
  const home = BOX_SCORE_CODES[g.home] ?? g.home
  return `https://www.basketball-reference.com/boxscores/${g.gameDate.replaceAll('-', '')}0${home}.html`
}

type PageGame = Pick<GameRow, 'id' | 'away' | 'home' | 'gameDate'>
type DraftScore = { homeScore: number; awayScore: number }

/** "YES for MEM@CLE, Final 106-111 (ESPN)": the outcome kind 0 gives the draft. */
const proposedWhat = (g: PageGame, d: DraftScore) =>
  `${outcomeFor(0, d.homeScore, d.awayScore, []).toUpperCase()} for ${g.away}@${g.home}, Final ${d.awayScore}-${d.homeScore} (ESPN)`

const uncheckedCause = (reason: 'match' | 'off' | 'pending', waitSecs: number) =>
  reason === 'off'
    ? 'BALLDONTLIE_API_KEY is not set'
    : `balldontlie had no final score ${Math.round(waitSecs / 60)} min after proposing opened`

export interface ProposedPage {
  check: 'match' | 'unchecked'
  reason: 'match' | 'off' | 'pending'
  hashHex: string
  /** proposed_at + the dispute window (unix seconds). */
  closesAt: number
  /** secondSourceWaitSecs, named in a CHECK page for a silent second source. */
  waitSecs: number
}

/** The `auto-proposed:` page once the keeper's proposal landed: checked, or CHECK. */
export function autoProposedText(g: PageGame, d: DraftScore, p: ProposedPage): string {
  const what = proposedWhat(g, d)
  if (p.check === 'match') {
    return (
      `Proposed ${what}. ESPN and balldontlie agree. Nothing to do. The challenge window closes at ` +
      `${utcAndEt(p.closesAt)}. sha256 ${p.hashHex.slice(0, 8)}...${p.hashHex.slice(-4)}. ` +
      `If wrong: horagon-ops challenge ${g.id}`
    )
  }
  return (
    `CHECK: proposed ${what}, with no second source: ${uncheckedCause(p.reason, p.waitSecs)}. ` +
    `Check the box score: ${boxScoreLink(g)}. If wrong, challenge before ${utcAndEt(p.closesAt)}: ` +
    `horagon-ops challenge ${g.id}`
  )
}

/** The `auto-proposed:` page of a dry run: what the keeper would have proposed. */
export function dryRunText(
  g: PageGame,
  d: DraftScore,
  a: Pick<Extract<Action, { type: 'propose' }>, 'check' | 'reason'>,
  waitSecs: number,
): string {
  const checked =
    a.check === 'match'
      ? 'ESPN and balldontlie agree'
      : `with no second source: ${uncheckedCause(a.reason, waitSecs)}`
  return (
    `DRY RUN: would propose ${proposedWhat(g, d)}, ${checked}. Nothing was sent; propose by hand: ` +
    `horagon-ops propose ${g.id} --box-score <url> --score ${d.homeScore}-${d.awayScore}`
  )
}

/** `source-held:`: the second source contradicts the draft, so nothing was proposed. */
export function heldText(
  g: PageGame,
  a: Pick<Extract<Action, { type: 'hold' }>, 'espn' | 'second'>,
): string {
  return (
    `HELD: ${g.away}@${g.home} ESPN ${a.espn.away}-${a.espn.home} vs balldontlie ` +
    `${a.second.away}-${a.second.home}, nothing proposed. Check the box score (${boxScoreLink(g)}), ` +
    `then: horagon-ops propose ${g.id} --box-score <url> --score <h>-<a> [--periods ...]`
  )
}

/** `source-mismatch:`: the second source contradicts a proposal still open to challenge. */
export function mismatchText(
  g: PageGame,
  a: Pick<Extract<Action, { type: 'mismatch' }>, 'proposed' | 'second' | 'challengeBy'>,
): string {
  return (
    `MISMATCH: ${g.away}@${g.home} balldontlie ${a.second.away}-${a.second.home} vs proposed ` +
    `${a.proposed.away}-${a.proposed.home}. Challenge before ${utcAndEt(a.challengeBy)}: ` +
    `horagon-ops challenge ${g.id}, then runbook C.`
  )
}

/**
 * What the keeper says at start about auto-propose: the `auto-propose-off` alert when it is off,
 * and a log warning when it is on (or dry) with nobody to page (no TELEGRAM_*).
 */
export function autoProposeNotices(
  auto: AutoProposeConfig,
  paged: boolean,
): { alert: string | null; warn: string | null } {
  if (auto.mode === 'off') {
    const why = auto.off ?? 'KEEPER_AUTO_PROPOSE=off'
    return {
      alert: `Auto-propose is off (${why}): propose every result by hand (runbook A).`,
      warn: null,
    }
  }
  return {
    alert: null,
    warn: paged
      ? null
      : `auto-propose is ${auto.mode} but TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set: its pages reach this log only`,
  }
}

const sameLive = (a: FeedGame, b: FeedGame) =>
  a.status === b.status &&
  a.homeScore === b.homeScore &&
  a.awayScore === b.awayScore &&
  a.period === b.period &&
  a.clockSecs === b.clockSecs

/** How long after end_ts a market with no result draft counts as stuck. */
const STUCK_AFTER_SECS = 6 * 3600
const UNRESOLVED: ReadonlySet<string> = new Set(['open', 'halted', 'challenged'])

/**
 * Markets the planner leaves alone that still need a person: closed over 6 h ago, not proposed,
 * no usable draft, and a feed that is stale (live), stuck on a Final it cannot draft, or missing.
 * A postponed, canceled or scheduled game has its own 7-day path. A rejected draft is not
 * usable, nor is a proposed one while the chain is challenged: that proposal is the one
 * challenged, whatever the DB says.
 */
export function stuckAlerts(states: readonly GameState[], now: number): Action[] {
  return states.flatMap((s): Action[] => {
    const chain = s.onchain
    if (!chain || !UNRESOLVED.has(chain.status)) return []
    if (now < chain.endTs + STUCK_AFTER_SECS) return []
    const draft = s.draft
    const usable =
      draft !== null &&
      draft.state !== 'rejected' &&
      !(draft.state === 'proposed' && chain.status === 'challenged')
    if (usable) return []
    if (s.feed && s.feed.status !== 'live' && s.feed.status !== 'final') return []
    const g = s.game
    return [
      {
        type: 'alert',
        gameId: g.id,
        key: `stuck:${g.id}`,
        text: `${g.away}@${g.home}: market closed over 6 h ago with no result draft; resolve by hand`,
      },
    ]
  })
}

const seconds = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : 0)

/**
 * A `sync` for each market whose row is behind the chain although the statuses match: a propose
 * and a challenge can both land between two chain reads (a sender wait, a restart), leaving the
 * row `challenged` like the chain, with an older count and proposal. The planner only compares
 * statuses, so this catches what it cannot see. Never a second sync for the same game.
 */
function driftSyncs(states: readonly GameState[], planned: readonly Action[]): Action[] {
  const syncing = new Set(planned.filter((a) => a.type === 'sync').map((a) => a.gameId))
  return states.flatMap((s): Action[] => {
    const { market, onchain } = s
    if (!market || !onchain || syncing.has(s.game.id)) return []
    const behind =
      onchain.challengeCount !== market.challengeCount ||
      onchain.proposedAt !== seconds(market.proposedAt)
    return behind ? [{ type: 'sync', gameId: s.game.id, marketId: onchain.marketId }] : []
  })
}

/** Consecutive failed treasury reads before `treasury-unread` goes out. */
const TREASURY_UNREAD_ALERT_AFTER = 10

/**
 * The on-chain challenge count (0 before any challenge). The `challenge:`, `draft:` and
 * `unconfirmed:` alert keys end with it: the alerter drops a repeated key within its window, so
 * without it a second challenge round inside that window would go unheard.
 */
const roundOf = (s: Pick<GameState, 'onchain'>) => s.onchain?.challengeCount ?? 0

export class Keeper {
  private readonly observed = new Map<string, Observed>()
  private readonly lastFetch = new Map<string, number>()
  private window: { secs: number; at: number } | null = null
  private treasuryFailures = 0
  /** Second-source checks by game id (R6). */
  private readonly checks = new Map<string, Check>()
  /** Why the last auto-propose of a game did not land; cleared when one lands. */
  private readonly proposeErrors = new Map<string, string>()
  /** `<gameId>:<round>` of the dry-run pages already sent. */
  private readonly dryPaged = new Set<string>()
  /** Games whose held-result record was read since the keeper started. */
  private readonly holdsRead = new Set<string>()
  /** `<gameId>:<round>:<evidence hash>` of the keeper's proposals whose page was delivered. */
  private readonly paged = new Set<string>()
  /** The Final score of the stored evidence behind each proposal on chain, by its hash. */
  private readonly proposals = new Map<string, { hash: string; score: Score }>()

  constructor(private readonly d: KeeperDeps) {}

  /** League dates that can have a game in play: from 12 h ago to 3 h ahead. */
  feedDates(now: number): string[] {
    return [...new Set([-12, 0, 3].map((h) => ET.format(new Date((now + h * 3600) * 1000))))]
  }

  observation(gameId: string): Observed | undefined {
    return this.observed.get(gameId)
  }

  async observe(now: number, rows: ReadonlyMap<string, GameRow>): Promise<void> {
    const every = this.d.feedEverySecs ?? 15
    for (const date of this.feedDates(now)) {
      if (now - (this.lastFetch.get(date) ?? 0) < every) continue
      // The attempt counts, not only a success: a failing or rate-limited feed is not hammered.
      this.lastFetch.set(date, now)
      let snap: Awaited<ReturnType<Feed['fetchDay']>>
      try {
        snap = await this.d.feed.fetchDay(date)
      } catch (err) {
        this.d.log.warn({ date, error: errorSummary(err).message }, 'feed read failed')
        continue
      }
      // Events ESPN answered but the parser could not read: a format change must not make
      // games disappear silently.
      if ((snap.skipped ?? 0) > 0) {
        await this.d.alerts.send(
          `feed-skipped:${date}`,
          `${snap.skipped} ESPN events on ${date} could not be read; check the feed`,
        )
      }
      for (const g of snap.games) {
        const id = gameIdOf(g)
        const prev = this.observed.get(id)
        const stillFinal =
          prev?.game.status === 'final' &&
          g.status === 'final' &&
          prev.game.homeScore === g.homeScore &&
          prev.game.awayScore === g.awayScore
        const finalSince =
          g.status === 'final' ? (stillFinal ? (prev?.finalSince ?? now) : now) : null
        this.observed.set(id, { game: g, seenAt: now, finalSince, url: snap.url })
        const row = rows.get(id)
        if (row && (!prev || !sameLive(prev.game, g)))
          await this.persistLive(row, g, snap.fetchedAt)
      }
    }
  }

  private async persistLive(row: GameRow, g: FeedGame, at: Date): Promise<void> {
    const modelProb = modelProbability(g, row.p0, this.d.sigma)
    await updateGameLive(this.d.db, row.id, {
      status: g.status,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      period: g.period,
      clockSecs: g.clockSecs,
      periods: g.periods,
      modelProb,
      feedUpdatedAt: at,
    })
    if (g.status === 'live' || g.status === 'final') {
      await insertSnapshot(this.d.db, {
        gameId: row.id,
        ts: at,
        homeScore: g.homeScore,
        awayScore: g.awayScore,
        period: g.period,
        clockSecs: g.clockSecs,
        modelProb,
      })
    }
  }

  private async disputeWindowSecs(now: number): Promise<number> {
    if (this.window && now - this.window.at < 600) return this.window.secs
    const config = await this.d.program.fetchConfig(this.d.sender.connection)
    if (!config) throw new Error('horagon Config is not initialized: run horagon-ops init-config')
    this.window = { secs: config.disputeWindowSecs, at: now }
    return config.disputeWindowSecs
  }

  /**
   * Every winner GameMarket, by market id. An account that does not decode is skipped for this
   * tick, with a warning and a `decode:<id>` alert: one bad account must not stop every game.
   */
  private async readChain(games: GameWithMarkets[]): Promise<Map<string, GameMarketAccount>> {
    const ids = games.flatMap((g) =>
      g.markets
        .filter((m) => m.kind === 0)
        .map((m) => ({ marketId: BigInt(m.marketId), gameId: g.id })),
    )
    const out = new Map<string, GameMarketAccount>()
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100)
      const infos = await this.d.sender.connection.getMultipleAccountsInfo(
        chunk.map((m) => deriveGameMarket(m.marketId, this.d.program.programId)),
        'confirmed',
      )
      for (const [j, info] of infos.entries()) {
        const m = chunk[j]
        if (!info || m === undefined) continue
        try {
          out.set(m.marketId.toString(), decodeGameMarket(info, this.d.program.programId))
        } catch (err) {
          const error = errorSummary(err).message
          this.d.log.warn({ gameId: m.gameId, error }, 'GameMarket does not decode; skipped')
          await this.d.alerts.send(
            `decode:${m.gameId}`,
            `${m.gameId}: its GameMarket account does not decode (${error}); the keeper skips this market`,
          )
        }
      }
    }
    return out
  }

  async tick(): Promise<Action[]> {
    const now = this.d.now()
    const games = await listGames(this.d.db, {
      from: new Date((now - 8 * 86_400) * 1000),
      to: new Date((now + 36 * 3600) * 1000),
    })
    await this.observe(now, new Map(games.map((g) => [g.id, g])))
    const [chain, disputeWindowSecs] = await Promise.all([
      this.readChain(games),
      this.disputeWindowSecs(now),
    ])
    const states: GameState[] = await Promise.all(
      games.map(async (g) => {
        const market = g.markets.find((m) => m.kind === 0) ?? null
        const obs = this.observed.get(g.id)
        return {
          game: g,
          market,
          onchain: market ? (chain.get(market.marketId) ?? null) : null,
          feed: obs?.game ?? null,
          feedSeenAt: obs?.seenAt ?? null,
          finalSince: obs?.finalSince ?? null,
          draft: market ? await getDraft(this.d.db, g.id) : null,
        }
      }),
    )
    await this.readHolds(states)
    await this.readProposed(states, now, disputeWindowSecs)
    await this.checkSecondSource(now, states, disputeWindowSecs)
    for (const s of states) {
      s.secondSource = this.secondSourceOf(s, now, disputeWindowSecs)
      s.proposeError = this.proposeErrors.get(s.game.id) ?? null
      s.pageOwed = this.pageOwed(s)
    }
    const planned = plan({
      now,
      states,
      timings: this.d.timings,
      seeds: this.d.seeds,
      disputeWindowSecs,
      autoPropose: this.d.autoPropose?.mode ?? 'off',
    })
    // The plan comes halts first, then syncs: the drift syncs join right after the halts.
    const halts = planned.filter((a) => a.type === 'halt')
    const actions = [
      ...halts,
      ...driftSyncs(states, planned),
      ...planned.filter((a) => a.type !== 'halt'),
      ...stuckAlerts(states, now),
    ]
    const byId = new Map(states.map((s) => [s.game.id, s]))
    for (const a of actions) {
      const s = byId.get(a.gameId)
      if (!s) continue
      try {
        await this.perform(a, s, now)
      } catch (err) {
        const program = err instanceof ProgramFailure
        this.d.log.error(
          { action: a.type, gameId: a.gameId, error: errorSummary(err).message },
          'action failed',
        )
        if (program)
          await this.d.alerts.send(
            `fail:${a.type}:${a.gameId}`,
            `${a.type} ${a.gameId} rejected: ${errorSummary(err).message}`,
          )
      }
    }
    return actions
  }

  private async perform(a: Action, s: GameState, now: number): Promise<void> {
    switch (a.type) {
      case 'create':
        return this.create(a, s.game)
      case 'halt':
        return this.halt(a, s)
      case 'draft':
        return this.draft(a, s, now)
      case 'finalize':
      case 'recycle':
        return this.settle(a, s)
      case 'sync':
        await this.sync(s)
        return
      case 'propose':
        return this.propose(a, s, now)
      case 'hold':
        await this.d.alerts.send(`source-held:${a.gameId}`, heldText(s.game, a))
        return
      case 'mismatch':
        await this.d.alerts.send(`source-mismatch:${a.gameId}`, mismatchText(s.game, a))
        return
      case 'announce':
        if (s.onchain) await this.page(s, s.onchain, a.closesAt)
        return
      case 'alert': {
        const unconfirmed = a.key.startsWith('unconfirmed:')
        await this.d.alerts.send(unconfirmed ? `${a.key}:${roundOf(s)}` : a.key, a.text)
        if (unconfirmed) await setDraftState(this.d.db, a.gameId, { alertedAt: new Date() })
        return
      }
    }
  }

  private get conn() {
    return this.d.sender.connection
  }

  /**
   * `proposed` of each proposal still inside its window: the Final score of the stored evidence
   * whose hash is on chain, read once per hash. Other evidence than the chain's leaves it null
   * (sync pages `evidence-mismatch:`), so nothing is checked against a score not on chain.
   */
  private async readProposed(
    states: readonly GameState[],
    now: number,
    windowSecs: number,
  ): Promise<void> {
    if (!this.d.autoPropose?.secondSource) return
    for (const s of states) {
      const gm = s.onchain
      if (gm?.status !== 'proposed' || now >= gm.proposedAt + windowSecs) continue
      const hash = toHex(gm.evidenceHash)
      const known = this.proposals.get(s.game.id)
      if (known?.hash === hash) {
        s.proposed = known.score
        continue
      }
      const stored = await getEvidence(this.d.db, s.game.id, 0)
      if (stored?.hash !== hash) continue
      const ev = parseResolutionEvidence(JSON.parse(stored.json))
      if (ev.status !== 'final') continue
      const score = { home: ev.homeScore, away: ev.awayScore }
      this.proposals.set(s.game.id, { hash, score })
      s.proposed = score
    }
  }

  /**
   * The score the second source should check for this game, or null: a pending Final draft the
   * keeper may propose (round 0), or, inside the window, the Final on chain (`proposed`).
   */
  private checkScore(s: GameState, now: number, windowSecs: number): Score | null {
    const { draft, onchain: chain, game: g } = s
    if (g.league !== 'NBA' || !chain) return null
    if (chain.status === 'proposed')
      return now < chain.proposedAt + windowSecs ? (s.proposed ?? null) : null
    const proposable =
      draft?.state === 'pending' &&
      draft.status === 'final' &&
      (chain.status === 'open' || chain.status === 'halted') &&
      chain.challengeCount === 0
    return proposable ? { home: draft.homeScore, away: draft.awayScore } : null
  }

  /**
   * Games whose score the second source should check (checkScore). A match against the same
   * score ends the checks; a mismatch keeps them going, so the sources can come to agree.
   */
  private wantsCheck(s: GameState, now: number, windowSecs: number): boolean {
    const score = this.checkScore(s, now, windowSecs)
    if (!score) return false
    const c = this.checks.get(s.game.id)
    return !(c?.verdict === 'match' && sameScore(c.draft, score))
  }

  /**
   * Asks the second source about every game that wants a check, one request per ET date (its
   * client spaces them), and keeps each verdict. A verdict that changes writes one ops line.
   */
  private async checkSecondSource(
    now: number,
    states: readonly GameState[],
    windowSecs: number,
  ): Promise<void> {
    const client = this.d.autoPropose?.secondSource
    if (!client) return
    const byDate = new Map<string, GameState[]>()
    for (const s of states) {
      if (!this.wantsCheck(s, now, windowSecs)) continue
      byDate.set(s.game.gameDate, [...(byDate.get(s.game.gameDate) ?? []), s])
    }
    for (const [date, group] of byDate) {
      let got: DateGames | null
      try {
        got = await client.games(date, now)
      } catch (err) {
        // BdlError messages carry the HTTP status only, never the key.
        const status = err instanceof BdlError ? err.status : null
        this.d.log.warn(
          { date, status, error: errorSummary(err).message },
          'second source read failed',
        )
        // A refused key fails every check until a person fixes it: a CHECK page would only say
        // balldontlie had no final score.
        if (status === 401 || status === 403) {
          await this.d.alerts.send(
            'second-source-refused',
            `balldontlie refused BALLDONTLIE_API_KEY (HTTP ${status}): it checks no result until the key in .env.keeper is fixed and the keeper restarted, so every proposal pages CHECK`,
          )
        }
        continue
      }
      if (!got) continue
      for (const s of group) {
        const score = this.checkScore(s, now, windowSecs)
        if (score) await this.recordCheck(s, got, score)
      }
    }
  }

  /**
   * After a restart, the hold of each pending Final draft balldontlie contradicted, read once per
   * game: without it, a balldontlie that stays silent after the restart would let the keeper
   * propose that result unchecked once the wait has passed.
   */
  private async readHolds(states: readonly GameState[]): Promise<void> {
    if (this.d.autoPropose?.mode !== 'on' || !this.d.autoPropose.secondSource) return
    for (const s of states) {
      const { game: g, draft } = s
      if (draft?.state !== 'pending' || draft.status !== 'final') continue
      if (g.league !== 'NBA' || this.checks.has(g.id) || this.holdsRead.has(g.id)) continue
      const row = await getHeartbeat(this.d.db, heldRecordKey(g.id))
      this.holdsRead.add(g.id)
      const held = HeldRecordSchema.safeParse(row?.info)
      const score = { home: draft.homeScore, away: draft.awayScore }
      if (!held.success || !held.data.second || !sameScore(held.data.draft, score)) continue
      const { since, second } = held.data
      this.checks.set(g.id, {
        verdict: 'mismatch',
        since,
        draft: score,
        second,
        bdlId: null,
        fetchedAt: since,
      })
    }
  }

  private async recordCheck(s: GameState, got: DateGames, score: Score): Promise<void> {
    const g = s.game
    const found = findGame(got.games, g.home, g.away)
    const game = found ? secondGame(found) : null
    const verdict = verdictOf({ homeScore: score.home, awayScore: score.away }, game)
    const second =
      game && game.homeScore !== null && game.awayScore !== null
        ? { home: game.homeScore, away: game.awayScore }
        : null
    const prev = this.checks.get(g.id)
    const held = prev?.verdict === 'mismatch' && sameScore(prev.draft, score)
    // A hold ends only when balldontlie agrees with the draft: a game it no longer lists, or no
    // final from it, is silence, not agreement.
    if (held && verdict === 'pending') return
    const same = prev !== undefined && prev.verdict === verdict && sameScore(prev.draft, score)
    const since = same ? prev.since : got.fetchedAt
    this.checks.set(g.id, {
      verdict,
      since,
      draft: score,
      second,
      bdlId: game?.id ?? null,
      fetchedAt: got.fetchedAt,
    })
    // The hold outlives a restart (readHolds): written when it starts or its score changes, and
    // cleared when balldontlie comes to agree. A dry run proposes nothing, so it keeps none.
    const moved =
      verdict === 'mismatch'
        ? !(same && prev.second && second && sameScore(prev.second, second))
        : held
    if (moved && this.d.autoPropose?.mode === 'on') {
      await heartbeat(this.d.db, heldRecordKey(g.id), {
        draft: score,
        second: verdict === 'mismatch' ? second : null,
        since,
      })
    }
    if (same) return
    await logOps(this.d.db, {
      actor: 'keeper',
      action: 'second-source',
      gameId: g.id,
      market: s.market?.pubkey ?? null,
      sig: null,
      detail: {
        source: 'balldontlie',
        verdict,
        draft: `${score.home}-${score.away}`,
        second: second ? `${second.home}-${second.away}` : null,
        ...(game ? { id: game.id, state: game.state } : {}),
      },
    })
  }

  /**
   * The planner's view of the second source for this game's current draft, or inside the window
   * for the proposal on chain.
   */
  private secondSourceOf(s: GameState, now: number, windowSecs: number): SecondSourceState | null {
    const auto = this.d.autoPropose
    if (!auto) return null
    if (!auto.secondSource) return { verdict: 'off', since: now }
    const c = this.checks.get(s.game.id)
    const gm = s.onchain
    const d = s.draft
    const score =
      gm?.status === 'proposed' && now < gm.proposedAt + windowSecs
        ? (s.proposed ?? null)
        : d
          ? { home: d.homeScore, away: d.awayScore }
          : null
    if (!c || !score || !sameScore(c.draft, score)) return null
    if (c.verdict === 'mismatch')
      return c.second ? { verdict: 'mismatch', since: c.since, score: c.second } : null
    return { verdict: c.verdict, since: c.since }
  }

  /**
   * Auto-propose (R6): the shared propose core with the attestor, as `horagon-ops propose` does
   * it. A dry run pages once per game and round, and sends and writes nothing. A chain clock
   * still before end_ts (or a market no longer proposable) is a skip, retried next tick; a
   * rejected send throws, so the tick's `fail:propose:` alert goes out.
   */
  private async propose(
    a: Extract<Action, { type: 'propose' }>,
    s: GameState,
    now: number,
  ): Promise<void> {
    const auto = this.d.autoPropose
    const draft = s.draft
    if (!auto || !draft) return
    const g = s.game
    const round = roundOf(s)
    const waitSecs = this.d.timings.secondSourceWaitSecs
    if (auto.mode === 'dry') {
      const once = `${g.id}:${round}`
      if (this.dryPaged.has(once)) return
      this.d.log.info(
        { gameId: g.id, check: a.check, reason: a.reason },
        'auto-propose dry run: would propose',
      )
      await this.d.alerts.send(`auto-proposed:${g.id}:${round}`, dryRunText(g, draft, a, waitSecs))
      this.dryPaged.add(once)
      return
    }
    const c = this.checks.get(g.id)
    let confirm: ConfirmSource | null = null
    if (a.check === 'match') {
      if (c?.verdict !== 'match' || c.bdlId === null)
        throw new Error(`${g.id}: a checked propose without a balldontlie match`)
      confirm = {
        name: 'balldontlie',
        url: bdlGameUrl(c.bdlId),
        at: new Date(c.fetchedAt * 1000),
      }
    }
    let out: ProposeOutcome
    try {
      out = await proposeResult(
        {
          db: this.d.db,
          connection: this.conn,
          program: this.d.program,
          sender: this.d.sender,
          signer: this.d.attestor,
          actor: 'keeper',
          priorityMicroLamports: this.d.priority.normal,
          now: () => new Date(this.d.now() * 1000),
        },
        {
          gameId: g.id,
          uri: auto.evidenceUri(g.id),
          wish: {
            gameId: g.id,
            status: 'final',
            home: draft.homeScore,
            away: draft.awayScore,
            periods: null,
            sourceUrl: draft.sourceUrl,
          },
          confirm,
          replace: false,
          keepStored: true,
        },
      )
    } catch (err) {
      this.proposeErrors.set(g.id, errorSummary(err).message)
      throw err
    }
    if (out.kind !== 'landed') {
      const why =
        out.kind === 'not-yet'
          ? 'the chain clock is still before end_ts'
          : `the market is ${out.status ?? 'missing'} on chain`
      this.proposeErrors.set(g.id, why)
      this.d.log.info({ gameId: g.id, why }, 'auto-propose skipped')
      return
    }
    this.proposeErrors.delete(g.id)
    // The row gets proposed_at and the evidence check at once, not a tick later. If this read or
    // the page fails, the planner's `announce` sends the page on a later tick.
    const gm = await this.sync(s)
    if (gm?.status === 'proposed')
      await this.page(s, gm, gm.proposedAt + (await this.disputeWindowSecs(now)))
  }

  private pagedKey(gameId: string, gm: GameMarketAccount): string {
    return `${gameId}:${gm.challengeCount}:${toHex(gm.evidenceHash)}`
  }

  /** A proposal on chain that the keeper's attestor made, whose page was not delivered yet. */
  private pageOwed(s: GameState): boolean {
    const gm = s.onchain
    if (this.d.autoPropose?.mode !== 'on' || gm?.status !== 'proposed') return false
    if (!gm.proposer.equals(this.d.attestor.publicKey)) return false
    return !this.paged.has(this.pagedKey(s.game.id, gm))
  }

  /**
   * The `auto-proposed:` page of the keeper's proposal on chain, built from the evidence whose
   * hash is on chain: checked when it cites balldontlie too, else CHECK. Kept as delivered once
   * the alerter says so; until then the planner asks for it again each tick (`announce`).
   */
  private async page(s: GameState, gm: GameMarketAccount, closesAt: number): Promise<void> {
    const g = s.game
    const key = this.pagedKey(g.id, gm)
    if (this.paged.has(key)) return
    const hashHex = toHex(gm.evidenceHash)
    const stored = await getEvidence(this.d.db, g.id, 0)
    // Other evidence than the chain's is `evidence-mismatch:` (sync), not a page to build.
    if (stored?.hash !== hashHex) return
    const ev = parseResolutionEvidence(JSON.parse(stored.json))
    const checked = ev.sources.length > 1
    const delivered = await this.d.alerts.send(
      `auto-proposed:${g.id}:${gm.challengeCount}`,
      autoProposedText(g, ev, {
        check: checked ? 'match' : 'unchecked',
        reason: checked ? 'match' : this.d.autoPropose?.secondSource ? 'pending' : 'off',
        hashHex,
        closesAt,
        waitSecs: this.d.timings.secondSourceWaitSecs,
      }),
    )
    if (delivered !== false) this.paged.add(key)
  }

  /** The first salted market id that is free or already ours (spec 5.1). */
  private async marketIdFor(
    g: GameRow,
  ): Promise<{ marketId: bigint; existing: GameMarketAccount | null }> {
    for (let salt = 0; salt <= 9; salt++) {
      const marketId = await marketIdFor(g.league, g.externalId, 0, salt)
      const existing = await this.d.program.fetchGameMarket(this.conn, marketId)
      if (!existing) return { marketId, existing: null }
      if (existing.externalGameId === g.externalId && existing.kind === 0)
        return { marketId, existing }
    }
    throw new Error(`${g.id}: market ids for salts 0-9 all belong to other games`)
  }

  /**
   * Adopts a GameMarket that is already on chain (a create that landed but was never recorded:
   * a crash, a DB error, an UnresolvedAttempt that landed later), else seeds and creates one.
   * The treasury is read only on the path that is about to send: once a create has landed its
   * seed is gone from the treasury, and reading first would report a false empty treasury.
   */
  private async create(a: Extract<Action, { type: 'create' }>, g: GameRow): Promise<void> {
    const { marketId, existing } = await this.marketIdFor(g)
    if (existing) {
      await this.record(g, marketId, {
        initialPriceBps: a.initialPriceBps,
        endTs: existing.endTs,
        seed: existing.seedAmount,
        status: existing.status,
        sig: null,
        action: 'adopt',
      })
      return
    }
    const balance = await this.treasuryBalance(g)
    if (balance === null) return
    let seed = a.seedAmount
    if (balance < seed) {
      if (a.featured && balance >= this.d.seeds.regular) {
        seed = this.d.seeds.regular
        await this.d.alerts.send(
          'treasury-low',
          `Treasury ${balance / 1_000_000n} mUSDC: ${g.id} seeded at 300 instead of 1,000`,
        )
      } else {
        await this.d.alerts.send(
          `treasury-empty:${g.id}`,
          `Treasury ${balance / 1_000_000n} mUSDC: cannot seed ${g.id}`,
        )
        return
      }
    }
    const tip = Math.floor(g.scheduledTipoff.getTime() / 1000)
    const ix = this.d.program.ix.createGameMarket({
      attestor: this.d.attestor.publicKey,
      marketId,
      kind: 0,
      league: g.league,
      externalGameId: g.externalId,
      home: g.home,
      away: g.away,
      scheduledTipoff: tip,
      endTs: a.endTs,
      name: marketName({
        league: g.league,
        away: g.away,
        home: g.home,
        gameDate: g.gameDate,
        kind: 0,
      }),
      initialPriceBps: a.initialPriceBps,
      seedAmount: seed,
    })
    const res = await this.d.sender.send({
      label: `create ${g.id}`,
      instructions: [ix],
      computeUnits: CREATE_MARKET_COMPUTE_UNITS,
      priorityMicroLamports: this.d.priority.normal,
      isDone: async () => (await this.d.program.fetchGameMarket(this.conn, marketId)) !== null,
    })
    await this.record(g, marketId, {
      initialPriceBps: a.initialPriceBps,
      endTs: a.endTs,
      seed,
      status: 'open',
      sig: res.signature,
      action: 'create',
    })
  }

  /**
   * The treasury's mUSDC, or null when the RPC cannot say. A missing account holds 0. An unread
   * balance is not an empty treasury: no alert and no create this tick (the planner asks again),
   * but 10 failed reads in a row send `treasury-unread`.
   */
  private async treasuryBalance(g: GameRow): Promise<bigint | null> {
    try {
      const balance = await this.conn
        .getTokenAccountBalance(this.d.program.treasury, 'confirmed')
        .then(
          (r) => BigInt(r.value.amount),
          (err: unknown) => {
            if (isMissingAccount(err)) return 0n
            throw err
          },
        )
      this.treasuryFailures = 0
      return balance
    } catch (err) {
      const error = errorSummary(err).message
      this.treasuryFailures++
      this.d.log.warn({ gameId: g.id, error }, 'create skipped: treasury balance unread')
      if (this.treasuryFailures >= TREASURY_UNREAD_ALERT_AFTER) {
        await this.d.alerts.send(
          'treasury-unread',
          `Treasury balance could not be read ${this.treasuryFailures} times in a row (${error}); no market is created until it can`,
        )
      }
      return null
    }
  }

  /** The market row and the ops log entry, for a create or an adoption. */
  private async record(
    g: GameRow,
    marketId: bigint,
    m: {
      initialPriceBps: number
      endTs: number
      seed: bigint
      status: string
      sig: string | null
      action: 'create' | 'adopt'
    },
  ): Promise<void> {
    const addrs = this.d.program.addresses(marketId)
    await upsertMarket(this.d.db, {
      pubkey: addrs.market.toBase58(),
      gameId: g.id,
      kind: 0,
      marketId: marketId.toString(),
      gameMarketPda: addrs.gameMarket.toBase58(),
      yesMint: addrs.yesMint.toBase58(),
      noMint: addrs.noMint.toBase58(),
      initialPriceBps: m.initialPriceBps,
      endTs: new Date(m.endTs * 1000),
      seedAmount: m.seed,
      status: m.status,
      createSig: m.sig,
    })
    await logOps(this.d.db, {
      actor: 'keeper',
      action: m.action,
      gameId: g.id,
      market: addrs.market.toBase58(),
      sig: m.sig,
      detail: { seed: m.seed.toString(), priceBps: m.initialPriceBps, endTs: m.endTs },
    })
  }

  private async halt(a: Extract<Action, { type: 'halt' }>, s: GameState): Promise<void> {
    const ixs = this.d.program.ix.halt(
      { signer: this.d.attestor.publicKey, marketId: a.marketId },
      this.d.attestor.publicKey,
    )
    const res = await this.d.sender.send({
      label: `halt ${a.gameId} (${a.rule})`,
      instructions: ixs,
      computeUnits: HEAVY_IX_COMPUTE_UNITS,
      priorityMicroLamports: this.d.priority.halt,
      // A null read (a lagging RPC) is not proof of anything: only a GameMarket seen not open is.
      isDone: async () => {
        const gm = await this.d.program.fetchGameMarket(this.conn, a.marketId)
        return gm !== null && gm.status !== 'open'
      },
    })
    if (s.market)
      await updateMarket(this.d.db, s.market.pubkey, { status: 'halted', haltSig: res.signature })
    await logOps(this.d.db, {
      actor: 'keeper',
      action: 'halt',
      gameId: a.gameId,
      market: s.market?.pubkey ?? null,
      sig: res.signature,
      detail: { rule: a.rule },
    })
    await this.d.alerts.send(`halt:${a.gameId}`, `Halted ${s.game.away}@${s.game.home}: ${a.rule}`)
  }

  private async draft(
    a: Extract<Action, { type: 'draft' }>,
    s: GameState,
    now: number,
  ): Promise<void> {
    const g = s.game
    const obs = this.observed.get(g.id)
    await upsertDraft(this.d.db, {
      gameId: g.id,
      status: a.status,
      homeScore: a.homeScore,
      awayScore: a.awayScore,
      periods: a.periods,
      sourceUrl: obs?.url ?? espnScoreboardUrl(g.gameDate),
      fetchedAt: new Date((obs?.finalSince ?? now) * 1000),
    })
    // end_ts from the chain (a draft needs the GameMarket), else from the market row.
    const endTs =
      s.onchain?.endTs ?? (s.market ? Math.floor(s.market.endTs.getTime() / 1000) : null)
    // The keeper proposes this one itself: from max(Final held 60 s, end_ts).
    const auto = this.d.autoPropose
    const own =
      auto?.mode === 'on' && a.status === 'final' && roundOf(s) === 0 && g.league === 'NBA'
    const from =
      own && endTs !== null
        ? {
            from: Math.max((obs?.finalSince ?? now) + this.d.timings.finalStableSecs, endTs),
            secondSource: auto.secondSource ? ('balldontlie' as const) : ('off' as const),
          }
        : null
    await this.d.alerts.send(`draft:${g.id}:${roundOf(s)}`, draftText(g, a, endTs, now, from))
  }

  private async settle(
    a: Extract<Action, { type: 'finalize' | 'recycle' }>,
    s: GameState,
  ): Promise<void> {
    const payer = this.d.attestor.publicKey
    const instructions =
      a.type === 'finalize'
        ? [this.d.program.ix.finalize({ marketId: a.marketId })]
        : this.d.program.ix.recycle({ marketId: a.marketId }, payer)
    const done =
      a.type === 'finalize' ? (st: string) => st !== 'proposed' : (st: string) => st === 'recycled'
    const res = await this.d.sender.send({
      label: `${a.type} ${a.gameId}`,
      instructions,
      computeUnits: HEAVY_IX_COMPUTE_UNITS,
      priorityMicroLamports: this.d.priority.normal,
      // Only a GameMarket actually read can say the step is done; a null read is not "not proposed".
      isDone: async () => {
        const gm = await this.d.program.fetchGameMarket(this.conn, a.marketId)
        return gm !== null && done(gm.status)
      },
    })
    if (s.market) {
      await updateMarket(
        this.d.db,
        s.market.pubkey,
        a.type === 'finalize' ? { finalizeSig: res.signature } : { recycleSig: res.signature },
      )
    }
    await logOps(this.d.db, {
      actor: 'keeper',
      action: a.type,
      gameId: a.gameId,
      market: s.market?.pubkey ?? null,
      sig: res.signature,
      detail: {},
    })
    await this.sync(s)
  }

  /**
   * The API serves the stored evidence (kind 0): it must be the one whose hash is on chain, or
   * nobody can verify the result. Read only when a sync sees a hash on chain, never per tick.
   * True when the stored evidence is the chain's.
   */
  private async checkEvidence(s: GameState, chainHash: string): Promise<boolean> {
    const stored = await getEvidence(this.d.db, s.game.id, 0)
    if (stored?.hash === chainHash) return true
    await this.d.alerts.send(
      `evidence-mismatch:${s.game.id}`,
      `Evidence mismatch: ${s.game.away}@${s.game.home} has sha256 ${chainHash} on chain, but the ` +
        `API serves ${stored ? `sha256 ${stored.hash}` : 'no evidence'}. Check it before the dispute window closes.`,
    )
    return false
  }

  /** Copy the GameMarket's status, outcome and times into the DB row; returns what it read. */
  private async sync(s: GameState): Promise<GameMarketAccount | null> {
    if (!s.market) return null
    const gm = await this.d.program.fetchGameMarket(this.conn, BigInt(s.market.marketId))
    if (!gm) return null
    // A challenge rejects the draft. The planner ignores only rejected drafts and upsertDraft
    // never overwrites a proposed one, so without this the market would wait on the challenged
    // draft forever. A challenge is a status change into `challenged`, or a count that grew (a
    // propose and a second challenge between two chain reads). A `challenged` chain alone is
    // not one: ops may mark a draft proposed before its propose lands. Rejected before the row
    // is synced: if this write fails, the row still differs from the chain and the next tick
    // syncs (and rejects) again.
    const challenged = gm.status === 'challenged'
    const newChallenge = gm.challengeCount > s.market.challengeCount
    const statusMoved = s.market.status !== gm.status
    if (challenged && (statusMoved || newChallenge) && s.draft && s.draft.state !== 'rejected')
      await setDraftState(this.d.db, s.game.id, { state: 'rejected' })
    const evidenceHash = gm.evidenceHash.some((b) => b !== 0) ? toHex(gm.evidenceHash) : null
    // Checked before the row is synced: if the read fails, the next tick syncs (and checks) again.
    const ours = evidenceHash !== null && (await this.checkEvidence(s, evidenceHash))
    // A proposal of the stored evidence whose writes after landing failed (or a crash before
    // them) leaves its draft pending: the second-source check of the window needs it proposed.
    if (ours && gm.status === 'proposed' && s.draft?.state === 'pending')
      await setDraftState(this.d.db, s.game.id, { state: 'proposed' })
    const settled = gm.status === 'finalized' || gm.status === 'recycled'
    await updateMarket(this.d.db, s.market.pubkey, {
      status: gm.status,
      outcome: settled ? gm.proposedOutcome : null,
      challengeCount: gm.challengeCount,
      evidenceHash,
      proposedAt: gm.proposedAt > 0 ? new Date(gm.proposedAt * 1000) : null,
      finalizedAt: gm.finalizedAt > 0 ? new Date(gm.finalizedAt * 1000) : null,
      ...(gm.status === 'recycled' && s.market.status !== 'recycled'
        ? { recycledAt: new Date() }
        : {}),
    })
    if (newChallenge || (challenged && statusMoved)) {
      // The count can grow while the chain is already past `challenged`: a re-proposal landed
      // between two chain reads. Asking for another proposal then would be wrong.
      const name = `${s.game.away}@${s.game.home}`
      await this.d.alerts.send(
        `challenge:${s.game.id}:${gm.challengeCount}`,
        challenged
          ? `Challenged: ${name}. Re-check and propose again.`
          : `Challenged: ${name} was challenged and has been re-proposed (now ${gm.status}). Check the new proposal.`,
      )
    }
    return gm
  }
}
