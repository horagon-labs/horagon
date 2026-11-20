// One keeper tick (spec 7, every 5 s): read the feed, refresh live game rows and the model
// probability, read every GameMarket on chain, plan, then perform each action. An action that
// fails is logged and retried on a later tick; it never stops the others.
import {
  type Db,
  type GameRow,
  type GameWithMarkets,
  getDraft,
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
  winProbability,
} from '@horagon/sdk'
import { toHex } from '@horagon/sdk/evidence'
import type { Keypair } from '@solana/web3.js'
import type { Logger } from 'pino'
import type { Alerter } from './alerts'
import { ProgramFailure, type TxSender } from './executor'
import { espnScoreboardUrl } from './feeds/espn'
import { type Feed, type FeedGame, gameIdOf } from './feeds/types'
import { type Action, type GameState, plan, type SeedPolicy, type Timings } from './planner'

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
}

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
const sameLive = (a: FeedGame, b: FeedGame) =>
  a.status === b.status &&
  a.homeScore === b.homeScore &&
  a.awayScore === b.awayScore &&
  a.period === b.period &&
  a.clockSecs === b.clockSecs

/** A token account that does not exist holds nothing; any other RPC failure is not an answer. */
const isMissingAccount = (err: unknown) =>
  /could not find account|account does not exist/i.test(errorSummary(err).message)

/** How long after end_ts a market with no result draft counts as stuck. */
const STUCK_AFTER_SECS = 6 * 3600
const UNRESOLVED: ReadonlySet<string> = new Set(['open', 'halted', 'challenged'])

/**
 * Markets the planner leaves alone that still need a person: closed over 6 h ago, not proposed,
 * no usable draft (none, or rejected), and a feed that is stale (live), stuck on a Final it
 * cannot draft, or missing. A postponed, canceled or scheduled game has its own 7-day path.
 */
export function stuckAlerts(states: readonly GameState[], now: number): Action[] {
  return states.flatMap((s): Action[] => {
    const chain = s.onchain
    if (!chain || !UNRESOLVED.has(chain.status)) return []
    if (now < chain.endTs + STUCK_AFTER_SECS) return []
    if (s.draft && s.draft.state !== 'rejected') return []
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

export class Keeper {
  private readonly observed = new Map<string, Observed>()
  private readonly lastFetch = new Map<string, number>()
  private window: { secs: number; at: number } | null = null

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
      let snap: Awaited<ReturnType<Feed['fetchDay']>>
      try {
        snap = await this.d.feed.fetchDay(date)
      } catch (err) {
        this.d.log.warn({ date, error: errorSummary(err).message }, 'feed read failed')
        continue
      }
      this.lastFetch.set(date, now)
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

  private async readChain(games: GameWithMarkets[]): Promise<Map<string, GameMarketAccount>> {
    const ids = games.flatMap((g) =>
      g.markets.filter((m) => m.kind === 0).map((m) => BigInt(m.marketId)),
    )
    const out = new Map<string, GameMarketAccount>()
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100)
      const infos = await this.d.sender.connection.getMultipleAccountsInfo(
        chunk.map((id) => deriveGameMarket(id, this.d.program.programId)),
        'confirmed',
      )
      infos.forEach((info, j) => {
        const id = chunk[j]
        if (info && id !== undefined)
          out.set(id.toString(), decodeGameMarket(info, this.d.program.programId))
      })
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
    const actions = [
      ...plan({
        now,
        states,
        timings: this.d.timings,
        seeds: this.d.seeds,
        disputeWindowSecs,
      }),
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
            `${a.type} ${a.gameId} rejected: ${(err as Error).message}`,
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
        return this.draft(a, s.game, now)
      case 'finalize':
      case 'recycle':
        return this.settle(a, s)
      case 'sync':
        return this.sync(s)
      case 'alert':
        await this.d.alerts.send(a.key, a.text)
        if (a.key.startsWith('unconfirmed:'))
          await setDraftState(this.d.db, a.gameId, { alertedAt: new Date() })
        return
    }
  }

  private get conn() {
    return this.d.sender.connection
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

  private async create(a: Extract<Action, { type: 'create' }>, g: GameRow): Promise<void> {
    let balance: bigint
    try {
      balance = await this.conn.getTokenAccountBalance(this.d.program.treasury, 'confirmed').then(
        (r) => BigInt(r.value.amount),
        (err: unknown) => {
          if (isMissingAccount(err)) return 0n
          throw err
        },
      )
    } catch (err) {
      // An unread balance is not an empty treasury: no alert, no create this tick. The planner
      // asks for the create again on the next tick while the window is open.
      this.d.log.warn(
        { gameId: g.id, error: errorSummary(err).message },
        'create skipped: treasury balance unread',
      )
      return
    }
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
    const { marketId, existing } = await this.marketIdFor(g)
    const tip = Math.floor(g.scheduledTipoff.getTime() / 1000)
    let sig: string | null = null
    if (!existing) {
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
      sig = res.signature
    }
    const addrs = this.d.program.addresses(marketId)
    await upsertMarket(this.d.db, {
      pubkey: addrs.market.toBase58(),
      gameId: g.id,
      kind: 0,
      marketId: marketId.toString(),
      gameMarketPda: addrs.gameMarket.toBase58(),
      yesMint: addrs.yesMint.toBase58(),
      noMint: addrs.noMint.toBase58(),
      initialPriceBps: a.initialPriceBps,
      endTs: new Date((existing?.endTs ?? a.endTs) * 1000),
      seedAmount: existing?.seedAmount ?? seed,
      status: existing?.status ?? 'open',
      createSig: sig,
    })
    await logOps(this.d.db, {
      actor: 'keeper',
      action: existing ? 'adopt' : 'create',
      gameId: g.id,
      market: addrs.market.toBase58(),
      sig,
      detail: { seed: seed.toString(), priceBps: a.initialPriceBps, endTs: a.endTs },
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
      isDone: async () =>
        (await this.d.program.fetchGameMarket(this.conn, a.marketId))?.status !== 'open',
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
    g: GameRow,
    now: number,
  ): Promise<void> {
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
    const text =
      a.status === 'final'
        ? `${g.away}@${g.home} Final ${a.awayScore}-${a.homeScore} (ESPN). Check the box score, then run:\n` +
          `horagon-ops propose ${g.id} --box-score <url> --score ${a.homeScore}-${a.awayScore}`
        : `${g.away}@${g.home} was not played within 7 days. Resolve NO:\n` +
          `horagon-ops propose ${g.id} --postponed --notice <url>`
    await this.d.alerts.send(`draft:${g.id}`, text)
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
      isDone: async () =>
        done((await this.d.program.fetchGameMarket(this.conn, a.marketId))?.status ?? ''),
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

  /** Copy the GameMarket's status, outcome and times into the DB row. */
  private async sync(s: GameState): Promise<void> {
    if (!s.market) return
    const gm = await this.d.program.fetchGameMarket(this.conn, BigInt(s.market.marketId))
    if (!gm) return
    // A challenge rejects the draft. The planner ignores only rejected drafts and upsertDraft
    // never overwrites a proposed one, so without this the market would wait on the challenged
    // draft forever. Rejected before the row is synced: if this write fails, the row still
    // differs from the chain and the next tick syncs (and rejects) again.
    if (gm.status === 'challenged' && s.draft && s.draft.state !== 'rejected')
      await setDraftState(this.d.db, s.game.id, { state: 'rejected' })
    const settled = gm.status === 'finalized' || gm.status === 'recycled'
    await updateMarket(this.d.db, s.market.pubkey, {
      status: gm.status,
      outcome: settled ? gm.proposedOutcome : null,
      challengeCount: gm.challengeCount,
      evidenceHash: gm.evidenceHash.some((b) => b !== 0) ? toHex(gm.evidenceHash) : null,
      proposedAt: gm.proposedAt > 0 ? new Date(gm.proposedAt * 1000) : null,
      finalizedAt: gm.finalizedAt > 0 ? new Date(gm.finalizedAt * 1000) : null,
      ...(gm.status === 'recycled' && s.market.status !== 'recycled'
        ? { recycledAt: new Date() }
        : {}),
    })
    if (gm.status === 'challenged' && s.market.status !== 'challenged') {
      await this.d.alerts.send(
        `challenge:${s.game.id}`,
        `Challenged: ${s.game.away}@${s.game.home}. Re-check and propose again.`,
      )
    }
  }
}
