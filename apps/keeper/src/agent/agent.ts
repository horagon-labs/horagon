// The disclosed reference agent: a team wallet, listed in docs/metrics-wallets.json, that trades
// toward the model on live winner markets when no other wallet has traded for a while, so prices
// move with the game and fans find a counterparty. Every swap carries the `horagon:bot` memo, so
// it never counts as a fan. One round (every AGENT_INTERVAL_SECS): read the keeper's DB and the
// chain, decide per market (decide.ts), send at most one swap per market, check the swaps of the
// round before (guards.ts: a gap that grew holds the market, then disables it unless a trade by
// another wallet shows), page on low balances. A round ends early when the stop signal comes, when a
// pause starts or when its snapshot is older than half an interval, and the next round starts
// at the market after the last one decided. Hourly: the faucet and the claims of settled markets.
// A dry run sends nothing and claims nothing; when the wallet holds less than the agent's spend
// cap it plans against that cap (a notional balance, `notional: true` on its decision lines), so
// it shows the swaps a funded live run would size.
import {
  type Db,
  getHeartbeat,
  heartbeat,
  lastOtherTrades,
  listAgentMarkets,
  walletClaimableMarkets,
  walletMarketTotals,
} from '@horagon/db'
import {
  ataAddress,
  decodeMarketAccount,
  errorSummary,
  liveMarket,
  type MarketAccount,
  SWAP_COMPUTE_UNITS,
  toPoolState,
  tradeAtas,
} from '@horagon/sdk'
import { AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { type AccountInfo, type Connection, PublicKey } from '@solana/web3.js'
import type { Logger } from 'pino'
import type { Alerter } from '../alerts'
import { type SendSpec, UnresolvedAttempt } from '../executor'
import { dueEvery } from '../loop'
import { isMissingAccount } from '../treasury'
import type { AgentParams } from './config'
import { type Decision, decide, leagueAllowed, type MarketView } from './decide'
import { ANOMALY_HOLD_SECS, AnomalyWatch, FailureGuard, Rotation, SpendBook } from './guards'
import { agentClaimInstructions, agentSwapInstructions, CLAIM_COMPUTE_UNITS } from './tx'

/** The faucet and the claims run at most this often. */
export const AGENT_HOURLY_SECS = 3_600

/**
 * Rounds in a row cut before their first decision (a read slower than half an interval: the
 * RPC or the database is degraded) before the agent logs SLOW_READS_MSG, and how often at most.
 */
export const SLOW_READS_ROUNDS = 3
export const SLOW_READS_WARN_SECS = 600
export const SLOW_READS_MSG = 'agent: rounds cut before their first decision, the reads are slow'

type AgentConnection = Pick<
  Connection,
  'getMultipleAccountsInfo' | 'getBalance' | 'getTokenAccountBalance'
>

export interface AgentDeps {
  db: Db
  /** The keeper's TxSender with the agent keypair as its payer (and only signer). */
  sender: {
    send(spec: SendSpec): Promise<{ signature: string | null }>
    connection: AgentConnection
  }
  /** The agent's public key; the keypair stays in the sender. */
  wallet: PublicKey
  collateralMint: PublicKey
  alerts: Alerter
  log: Logger
  params: AgentParams
  dryRun: boolean
  /** Unix seconds. */
  now: () => number
  /** Claims the pm-AMM faucet into a wallet; throws when rate limited. */
  faucet: (wallet: string) => Promise<unknown>
  priorityMicroLamports: number
}

export interface RoundReport {
  paused: boolean
  /** The markets the round read (0 when it read nothing: paused, or the read failed). */
  markets: number
  /** One per market decided, in the order decided. */
  decisions: Decision[]
  /** Swaps that landed this round. */
  sent: number
  failures: number
  /**
   * Why the round ended before its last market, whose turn then comes first in the next round:
   * `stale` when its snapshot grew older than half an interval (a slow send, or a slow read when
   * nothing was decided), `stop` when the stop signal came, `pause` when one of its failures
   * started a pause. Null when it went through every market.
   */
  cut: 'stale' | 'stop' | 'pause' | null
}

const emptyReport = (): RoundReport => ({
  paused: false,
  markets: 0,
  decisions: [],
  sent: 0,
  failures: 0,
  cut: null,
})

interface Snapshot {
  views: MarketView[]
  accounts: Map<string, MarketAccount>
  lamports: bigint
  musdc: bigint
}

/**
 * The read after a swap found the gap grown, and no trade by another wallet since the swap is
 * stored: the market is held (no swap, no page) for ANOMALY_HOLD_SECS, then disabled if none shows.
 */
export const ANOMALY_HELD_MSG =
  'agent: the price moved away from the model after its swap, and no other trade is stored yet; market held'

/** The dry run's low-mUSDC log line, written instead of the `agent-musdc` page. */
export const DRY_LOW_MUSDC_MSG =
  'agent: dry run, the wallet holds under AGENT_MIN_MUSDC; no page in a dry run, which plans against its spend cap'

const toSecs = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : null)
const musdcText = (raw: bigint) => (Number(raw) / 1e6).toFixed(2)
const chunks = <T>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

/** Raw amount of an SPL token account, 0 when it does not exist. */
const tokenAmount = (info: AccountInfo<Buffer> | null) =>
  info ? AccountLayout.decode(info.data).amount : 0n

export class ReferenceAgent {
  readonly book = new SpendBook()
  readonly watch = new AnomalyWatch()
  readonly failures: FailureGuard
  private readonly rotation = new Rotation()
  private readonly hourlyDue = dueEvery(AGENT_HOURLY_SECS)
  private rounds = 0
  private last: RoundReport = emptyReport()
  /** Rounds in a row that read and were cut before their first decision, and the last warning. */
  private slowRounds = 0
  private slowWarnedAt: number | null = null
  /** When a dry run last logged DRY_LOW_MUSDC_MSG (at most hourly). */
  private dryLowLoggedAt: number | null = null

  constructor(private readonly d: AgentDeps) {
    this.failures = new FailureGuard(d.params.maxFailures, d.params.pauseSecs)
  }

  private get conn(): AgentConnection {
    return this.d.sender.connection
  }

  private get usdcAta(): PublicKey {
    return getAssociatedTokenAddressSync(this.d.collateralMint, this.d.wallet)
  }

  /**
   * How long the snapshot of a round holds. A send can block for minutes (a dropped attempt,
   * then the sender's wait for it), and the model age, the fan lag and the end buffer hold only
   * while the snapshot is fresh.
   */
  private get freshSecs(): number {
    return this.d.params.intervalSecs / 2
  }

  /**
   * At start, before the first round: when the last run did not stop cleanly (a crash or a stall
   * exit, which systemd restarts on its own), the markets it disabled stay disabled. A run
   * stopped by hand wrote `stopped` in its last heartbeat (stop below), so the next one starts
   * clean: a restart by hand is how a market is traded again. Returns the markets disabled
   * again. Throws when the database does not answer: the agent does not start without knowing.
   */
  async resume(): Promise<string[]> {
    const row = await getHeartbeat(this.d.db, 'agent')
    const info = (row?.info ?? {}) as { stopped?: unknown; disabled?: unknown }
    if (info.stopped === true || !Array.isArray(info.disabled)) return []
    const markets = info.disabled.filter((m): m is string => typeof m === 'string')
    for (const market of markets) this.watch.disable(market)
    if (markets.length > 0) {
      this.d.log.warn(
        { markets },
        'agent: the markets disabled before an unplanned restart stay disabled',
      )
    }
    return markets
  }

  /** After the last round of a clean stop: the heartbeat says `stopped` (resume above). */
  async stop(): Promise<void> {
    await this.beat(this.last, this.d.now(), true)
  }

  /**
   * One round. `signal` is the stop signal: once it aborts, the round sends nothing new (a send
   * in flight still completes) and ends.
   */
  async round(signal?: AbortSignal): Promise<RoundReport> {
    const report = emptyReport()
    this.rounds++
    const started = this.d.now()
    if (this.failures.paused(started)) {
      // No read and no send while paused, but the heartbeat goes on: a pause is not a stall.
      const paused = { ...report, paused: true }
      await this.beat(paused, started)
      return paused
    }
    if (this.hourlyDue(started)) {
      await this.fund()
      report.failures += await this.claimAll(signal)
    }
    // The clock again: the faucet and the claims may have taken minutes. The snapshot is read
    // as of `now`, and every decision of the round is made on both.
    const now = this.d.now()
    let snap: Snapshot
    try {
      snap = await this.read(now)
    } catch (err) {
      await this.failed('read', err)
      report.failures++
      await this.beat(report, now)
      return report
    }
    report.markets = snap.views.length
    await this.balanceAlerts(snap, now)
    // What the round may still spend. Every swap it plans comes off, sent or not: a dry run,
    // a send whose result is unknown and one that failed alike, so one round never plans more
    // than the wallet held when it was read. A dry run whose wallet holds less than the spend
    // cap plans against the cap instead (a notional balance: it spends nothing either way).
    const cap = this.spendCap(snap.views.length)
    const notional = this.d.dryRun && snap.musdc < cap
    let balance = notional ? cap : snap.musdc
    // In turn: from the market after the last one decided, wrapping around.
    const order = snap.views.map((v) => v.market)
    const start = this.rotation.start(order)
    const views = [...snap.views.slice(start), ...snap.views.slice(0, start)]
    for (const [i, view] of views.entries()) {
      // Before each decision: a pause that a failure of this round started, a stop signal, or
      // a snapshot that a slow read or send made old, ends the round. The markets left are
      // decided first on the next round's fresh read.
      const ageSecs = this.d.now() - now
      let cut: RoundReport['cut'] = null
      if (this.failures.paused(now)) cut = 'pause'
      else if (signal?.aborted) cut = 'stop'
      else if (ageSecs > this.freshSecs) cut = 'stale'
      if (cut) {
        report.cut = cut
        this.d.log.info({ reason: cut, ageSecs, left: views.length - i }, 'agent round cut short')
        break
      }
      const decision = decide(view, { now, balance, params: this.d.params })
      report.decisions.push(decision)
      this.rotation.decided(view.market, order)
      this.logDecision(decision, notional)
      if (decision.action !== 'swap') continue
      balance -= decision.amountIn
      if (this.d.dryRun) continue
      const account = snap.accounts.get(view.market)
      if (!account) continue
      if (await this.swap(decision, account, now)) report.sent++
      else report.failures++
    }
    if (report.failures === 0) this.failures.clean()
    this.slowReads(report)
    await this.beat(report, now)
    return report
  }

  /**
   * The most the agent may spend on the markets of a round, from its own config: there is no
   * per-night cap, so AGENT_MAX_PER_GAME for each market.
   */
  private spendCap(markets: number): bigint {
    return this.d.params.maxPerGame * BigInt(markets)
  }

  /**
   * A round cut `stale` before its first decision read slower than half an interval: a degraded
   * RPC or database, and the agent trades nothing (safe, but silent). From SLOW_READS_ROUNDS such
   * rounds in a row, a warning at most every SLOW_READS_WARN_SECS. Any other round that read
   * ends the streak; a paused round and a failed read leave it as it was.
   */
  private slowReads(report: RoundReport): void {
    if (report.cut !== 'stale' || report.decisions.length > 0) {
      this.slowRounds = 0
      return
    }
    this.slowRounds++
    const at = this.d.now()
    if (this.slowRounds < SLOW_READS_ROUNDS) return
    if (this.slowWarnedAt !== null && at - this.slowWarnedAt < SLOW_READS_WARN_SECS) return
    this.slowWarnedAt = at
    this.d.log.warn(
      { rounds: this.slowRounds, freshSecs: this.freshSecs, markets: report.markets },
      SLOW_READS_MSG,
    )
  }

  /** The keeper's DB rows, the fan trades and the agent's totals, then the chain. */
  private async read(now: number): Promise<Snapshot> {
    const { params, wallet } = this.d
    const leagues = ['NBA', 'PRACTICE'].filter((l) => leagueAllowed(l, params.practice))
    const rows = await listAgentMarkets(this.d.db, leagues)
    const keys = rows.map((r) => r.pubkey)
    // The fan-lag window, or further back while a swap is still checked: a trade by another
    // wallet after that swap clears its check, however long ago the last round was.
    const oldest = this.watch.oldestPendingAt
    const sinceSecs = Math.min(now - params.fanLagSecs, oldest ?? Number.POSITIVE_INFINITY)
    const fans = await lastOtherTrades(
      this.d.db,
      keys,
      wallet.toBase58(),
      new Date(sinceSecs * 1000),
    )
    const totals = await walletMarketTotals(this.d.db, wallet.toBase58(), keys)
    const [infos, lamports, musdc] = await Promise.all([
      this.accountInfos(keys.map((k) => new PublicKey(k))),
      this.conn.getBalance(wallet, 'confirmed'),
      this.conn.getTokenAccountBalance(this.usdcAta, 'confirmed').then(
        (r) => BigInt(r.value.amount),
        (err: unknown) => {
          if (isMissingAccount(err)) return 0n
          throw err
        },
      ),
    ])
    const accounts = new Map<string, MarketAccount>()
    const views: MarketView[] = []
    for (const [i, row] of rows.entries()) {
      const info = infos[i] ?? null
      let account: MarketAccount | null = null
      if (info) {
        try {
          account = decodeMarketAccount(info)
          accounts.set(row.pubkey, account)
        } catch (err) {
          this.d.log.warn(
            { market: row.pubkey, error: errorSummary(err).message },
            'agent: market account does not decode',
          )
        }
      }
      const live = account ? liveMarket(account, now) : null
      const price = live && !live.closed ? live.price : null
      const fanAt = toSecs(fans.get(row.pubkey) ?? null)
      // Another wallet traded at or after the agent's last swap here: the price move is not the
      // agent's alone, so the check is cleared and the market stays enabled.
      if (fanAt !== null && this.watch.clearAfter(row.pubkey, fanAt)) {
        this.d.log.info(
          { market: row.pubkey, gameId: row.gameId, tradeAt: fanAt },
          'agent: another wallet traded after its swap; check cleared',
        )
      }
      // The gap grew with no such trade stored: held while the indexer may still be behind the
      // chain, then disabled when none shows by the end of the hold.
      const checked = this.watch.check(row.pubkey, price, now)
      if (checked.state !== 'none') {
        const { sent } = checked
        const fields = {
          market: row.pubkey,
          gameId: row.gameId,
          side: sent.side,
          model: sent.model,
          priceBefore: sent.price,
          priceNow: price,
        }
        if (checked.state === 'held' && checked.first) {
          this.d.log.warn({ ...fields, until: checked.until }, ANOMALY_HELD_MSG)
        } else if (checked.state === 'disabled') {
          this.d.log.error(fields, 'agent anomaly')
          await this.d.alerts.send(
            `agent-anomaly:${row.gameId}`,
            `Reference agent: after its ${sent.side.toUpperCase()} swap on ${row.away}@${row.home} the price moved away from the model (${sent.price.toFixed(3)} -> ${price?.toFixed(3)}, model ${sent.model.toFixed(3)}) and no trade by another wallet showed within ${ANOMALY_HOLD_SECS / 60} min; market disabled until the agent is restarted by hand`,
          )
        }
      }
      views.push({
        market: row.pubkey,
        gameId: row.gameId,
        league: row.league,
        kind: row.kind,
        marketStatus: row.status,
        gameStatus: row.gameStatus,
        period: row.period,
        clockSecs: row.clockSecs,
        tipoff: toSecs(row.scheduledTipoff) as number,
        endTs: toSecs(row.endTs) as number,
        modelProb: row.modelProb,
        modelAt: toSecs(row.feedUpdatedAt),
        lastFanTradeAt: fanAt,
        ...this.book.totals(row.pubkey, totals.get(row.pubkey)),
        price,
        pool: account && price !== null ? toPoolState(account) : null,
        disabled: this.watch.disabled(row.pubkey),
        held: this.watch.held(row.pubkey),
      })
    }
    this.watch.forgetExcept(new Set(keys))
    return { views, accounts, lamports: BigInt(lamports), musdc }
  }

  private async accountInfos(keys: PublicKey[]): Promise<Array<AccountInfo<Buffer> | null>> {
    const out: Array<AccountInfo<Buffer> | null> = []
    for (const chunk of chunks(keys, 100)) {
      out.push(...(await this.conn.getMultipleAccountsInfo(chunk, 'confirmed')))
    }
    return out
  }

  /**
   * `agent-sol` and `agent-musdc`. A dry run never pages `agent-musdc`: it claims no faucet and
   * plans against its spend cap, so a low wallet changes nothing there; it logs it at most
   * hourly instead.
   */
  private async balanceAlerts(snap: Snapshot, now: number): Promise<void> {
    const { params } = this.d
    if (snap.lamports < params.minSolLamports) {
      await this.d.alerts.send(
        'agent-sol',
        `Reference agent wallet holds ${Number(snap.lamports) / 1e9} SOL; fees need ${Number(params.minSolLamports) / 1e9}`,
      )
    }
    if (snap.musdc >= params.minMusdc) return
    if (this.d.dryRun) {
      if (this.dryLowLoggedAt !== null && now - this.dryLowLoggedAt < AGENT_HOURLY_SECS) return
      this.dryLowLoggedAt = now
      this.d.log.info(
        { musdc: musdcText(snap.musdc), minMusdc: musdcText(params.minMusdc), dryRun: true },
        DRY_LOW_MUSDC_MSG,
      )
      return
    }
    await this.d.alerts.send(
      'agent-musdc',
      `Reference agent wallet holds ${musdcText(snap.musdc)} mUSDC, under ${musdcText(params.minMusdc)}; the faucet adds 1,000 an hour`,
    )
  }

  /** `notional`: the round planned against the spend cap, not the wallet (a dry run). */
  private logDecision(d: Decision, notional: boolean): void {
    const fields = {
      market: d.market,
      gameId: d.gameId,
      price: d.price,
      model: d.model,
      gap: d.gap,
      dryRun: this.d.dryRun,
      ...(notional ? { notional: true } : {}),
      ...(d.action === 'swap'
        ? {
            side: d.side,
            size: musdcText(d.amountIn),
            target: d.target,
            expectedPrice: d.expectedPrice,
            reachesTarget: d.reachesTarget,
          }
        : { reason: d.reason }),
    }
    // A dry run logs every decision; a live run logs its swaps and keeps the skips at debug.
    if (this.d.dryRun || d.action === 'swap') this.d.log.info(fields, `agent ${d.action}`)
    else this.d.log.debug(fields, `agent ${d.action}`)
  }

  /**
   * One swap; false when it failed (counted). A swap that may still land counts as sent. `at` is
   * the round's read, which the price before the swap came from.
   */
  private async swap(
    d: Extract<Decision, { action: 'swap' }>,
    account: MarketAccount,
    at: number,
  ): Promise<boolean> {
    const market = new PublicKey(d.market)
    try {
      const atas = tradeAtas({
        user: this.d.wallet,
        market,
        collateralMint: account.collateralMint,
        authority: account.authority,
      })
      const infos = await this.conn.getMultipleAccountsInfo(atas.map(ataAddress), 'confirmed')
      const instructions = agentSwapInstructions({
        agent: this.d.wallet,
        market,
        collateralMint: account.collateralMint,
        authority: account.authority,
        direction: d.direction,
        amountIn: d.amountIn,
        minOut: d.minOut,
        createAtas: atas.filter((_, i) => !infos[i]),
      })
      const res = await this.d.sender.send({
        label: `swap ${d.gameId}`,
        instructions,
        computeUnits: SWAP_COMPUTE_UNITS,
        priorityMicroLamports: this.d.priorityMicroLamports,
      })
      this.sentSwap(d, at)
      this.d.log.info(
        {
          market: d.market,
          gameId: d.gameId,
          side: d.side,
          size: musdcText(d.amountIn),
          sig: res.signature,
        },
        'agent swap landed',
      )
      return true
    } catch (err) {
      // It may still land: counted as spent, and checked on the next read like a landed one (a
      // read that shows no move proves nothing and clears the check).
      if (err instanceof UnresolvedAttempt) this.sentSwap(d, at)
      await this.failed('send', err)
      return false
    }
  }

  /** A swap that landed or may land: its spend, and the anomaly check of the next read. */
  private sentSwap(d: Extract<Decision, { action: 'swap' }>, at: number): void {
    this.book.record(d.market, d.amountIn)
    this.watch.expect(d.market, {
      gameId: d.gameId,
      side: d.side,
      model: d.model,
      price: d.price,
      at,
    })
  }

  /** The faucet into the agent wallet; a refusal (rate limit) is expected and only logged. */
  private async fund(): Promise<void> {
    if (this.d.dryRun) {
      this.d.log.info('agent: dry run, no faucet claim')
      return
    }
    try {
      await this.d.faucet(this.d.wallet.toBase58())
      this.d.log.info('agent: faucet claimed')
    } catch (err) {
      this.d.log.info({ error: errorSummary(err).message }, 'agent: faucet skipped')
    }
  }

  /**
   * claim_winnings on every settled market where the agent holds winning shares (the chain
   * decides: resolved, and a winning balance above 0). Returns the failures.
   */
  private async claimAll(signal?: AbortSignal): Promise<number> {
    let failures = 0
    let rows: Array<{ pubkey: string; gameId: string }>
    let infos: Array<AccountInfo<Buffer> | null>
    try {
      rows = await walletClaimableMarkets(this.d.db, this.d.wallet.toBase58())
      if (rows.length === 0) return 0
      infos = await this.accountInfos(rows.map((r) => new PublicKey(r.pubkey)))
    } catch (err) {
      await this.failed('read', err)
      return 1
    }
    for (const [i, row] of rows.entries()) {
      // No new claim after the stop signal: the next run claims the rest.
      if (signal?.aborted) break
      const info = infos[i]
      if (!info) continue
      try {
        const account = decodeMarketAccount(info)
        if (!account.resolved || (account.winningSide !== 1 && account.winningSide !== 2)) continue
        const market = new PublicKey(row.pubkey)
        const sides = [
          { owner: this.d.wallet, mint: account.yesMint },
          { owner: this.d.wallet, mint: account.noMint },
        ]
        const [yes, no] = await this.conn.getMultipleAccountsInfo(
          sides.map(ataAddress),
          'confirmed',
        )
        const winning = tokenAmount((account.winningSide === 1 ? yes : no) ?? null)
        if (winning === 0n) continue
        const instructions = agentClaimInstructions({
          agent: this.d.wallet,
          market,
          collateralMint: account.collateralMint,
          createAtas: sides.filter((_, j) => ![yes, no][j]),
        })
        if (this.d.dryRun) {
          this.d.log.info(
            { market: row.pubkey, gameId: row.gameId, winning: musdcText(winning) },
            'agent claim (dry run)',
          )
          continue
        }
        const res = await this.d.sender.send({
          label: `claim ${row.gameId}`,
          instructions,
          computeUnits: CLAIM_COMPUTE_UNITS,
          priorityMicroLamports: this.d.priorityMicroLamports,
        })
        this.d.log.info(
          {
            market: row.pubkey,
            gameId: row.gameId,
            winning: musdcText(winning),
            sig: res.signature,
          },
          'agent claimed',
        )
      } catch (err) {
        failures++
        await this.failed('send', err)
      }
    }
    return failures
  }

  /**
   * One failed read or send, seen now: after the call returned, which for a send can be 90 s or
   * more after the round's read. A pause it starts lasts the full AGENT_PAUSE_SECS from here.
   */
  private async failed(kind: 'read' | 'send', err: unknown): Promise<void> {
    const error = errorSummary(err).message
    this.d.log.warn({ kind, error, streak: this.failures.count + 1 }, `agent ${kind} failed`)
    if (this.failures.fail(this.d.now())) {
      const { maxFailures, pauseSecs } = this.d.params
      this.d.log.error({ pauseSecs }, 'agent paused')
      await this.d.alerts.send(
        'agent-paused',
        `Reference agent paused ${pauseSecs / 60} min after ${maxFailures} failed reads or sends in a row (last: ${error})`,
      )
    }
  }

  /**
   * The `agent` row of keeper_heartbeats, written after every round, a paused or failed one
   * included, and once more with `stopped` at a clean stop; a failed write is only logged. It
   * carries the markets the round read and the ones it decided, and why it was cut, if it was.
   */
  private async beat(report: RoundReport, now: number, stopped = false): Promise<void> {
    this.last = report
    const paused = this.failures.paused(now)
    try {
      await heartbeat(this.d.db, 'agent', {
        round: this.rounds,
        dryRun: this.d.dryRun,
        // The Practice page says the agent trades a replay only when this is true and the run
        // is live (R8).
        practice: this.d.params.practice,
        paused,
        ...(paused ? { pausedUntil: this.failures.pausedUntil } : {}),
        markets: report.markets,
        decided: report.decisions.length,
        cut: report.cut,
        sent: report.sent,
        disabled: this.watch.disabledMarkets,
        ...(stopped ? { stopped: true } : {}),
      })
    } catch (err) {
      this.d.log.warn({ error: errorSummary(err).message }, 'agent heartbeat not written')
    }
  }
}
