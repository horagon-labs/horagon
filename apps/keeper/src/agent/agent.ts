// The disclosed reference agent: a team wallet, listed in docs/metrics-wallets.json, that trades
// toward the model on live winner markets when no fan has traded for a while, so prices move
// with the game and fans find a counterparty. Every swap carries the `horagon:bot` memo, so it
// never counts as a fan. One round (every AGENT_INTERVAL_SECS): read the keeper's DB and the
// chain, decide per market (decide.ts), send at most one swap per market, check the swaps of the
// round before, page on low balances. Hourly: the faucet and the claims of settled markets.
import {
  type Db,
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
import { AnomalyWatch, FailureGuard, SpendBook } from './guards'
import { agentClaimInstructions, agentSwapInstructions, CLAIM_COMPUTE_UNITS } from './tx'

/** The faucet and the claims run at most this often. */
export const AGENT_HOURLY_SECS = 3_600

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
  decisions: Decision[]
  /** Swaps that landed this round. */
  sent: number
  failures: number
}

interface Snapshot {
  views: MarketView[]
  accounts: Map<string, MarketAccount>
  lamports: bigint
  musdc: bigint
}

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
  private readonly hourlyDue = dueEvery(AGENT_HOURLY_SECS)
  private rounds = 0

  constructor(private readonly d: AgentDeps) {
    this.failures = new FailureGuard(d.params.maxFailures, d.params.pauseSecs)
  }

  private get conn(): AgentConnection {
    return this.d.sender.connection
  }

  private get usdcAta(): PublicKey {
    return getAssociatedTokenAddressSync(this.d.collateralMint, this.d.wallet)
  }

  async round(): Promise<RoundReport> {
    const now = this.d.now()
    const report: RoundReport = { paused: false, decisions: [], sent: 0, failures: 0 }
    this.rounds++
    if (this.failures.paused(now)) {
      // No read and no send while paused, but the heartbeat goes on: a pause is not a stall.
      const paused = { ...report, paused: true }
      await this.beat(paused, now)
      return paused
    }
    if (this.hourlyDue(now)) {
      await this.fund()
      report.failures += await this.claimAll(now)
    }
    let snap: Snapshot
    try {
      snap = await this.read(now)
    } catch (err) {
      await this.failed(now, 'read', err)
      report.failures++
      await this.beat(report, now)
      return report
    }
    await this.balanceAlerts(snap)
    // What the round may still spend. Every swap it plans comes off, sent or not: a dry run,
    // a send whose result is unknown and one that failed alike, so one round never plans more
    // than the wallet held when it was read.
    let balance = snap.musdc
    for (const view of snap.views) {
      if (this.failures.paused(now)) break
      const decision = decide(view, { now, balance, params: this.d.params })
      report.decisions.push(decision)
      this.logDecision(decision)
      if (decision.action !== 'swap') continue
      balance -= decision.amountIn
      if (this.d.dryRun) continue
      const account = snap.accounts.get(view.market)
      if (!account) continue
      if (await this.swap(decision, account, now)) report.sent++
      else report.failures++
    }
    if (report.failures === 0) this.failures.clean()
    await this.beat(report, now)
    return report
  }

  /** The keeper's DB rows, the fan trades and the agent's totals, then the chain. */
  private async read(now: number): Promise<Snapshot> {
    const { params, wallet } = this.d
    const leagues = ['NBA', 'PRACTICE'].filter((l) => leagueAllowed(l, params.practice))
    const rows = await listAgentMarkets(this.d.db, leagues)
    const keys = rows.map((r) => r.pubkey)
    const since = new Date((now - params.fanLagSecs) * 1000)
    const fans = await lastOtherTrades(this.d.db, keys, wallet.toBase58(), since)
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
      const anomaly = this.watch.check(row.pubkey, price)
      if (anomaly) {
        this.d.log.error(
          {
            market: row.pubkey,
            gameId: row.gameId,
            side: anomaly.side,
            model: anomaly.model,
            priceBefore: anomaly.price,
            priceNow: price,
          },
          'agent anomaly',
        )
        await this.d.alerts.send(
          `agent-anomaly:${row.gameId}`,
          `Reference agent: after its ${anomaly.side.toUpperCase()} swap on ${row.away}@${row.home} the price moved away from the model (${anomaly.price.toFixed(3)} -> ${price?.toFixed(3)}, model ${anomaly.model.toFixed(3)}); market disabled until the agent restarts`,
        )
      }
      views.push({
        market: row.pubkey,
        gameId: row.gameId,
        league: row.league,
        kind: row.kind,
        marketStatus: row.status,
        gameStatus: row.gameStatus,
        tipoff: toSecs(row.scheduledTipoff) as number,
        endTs: toSecs(row.endTs) as number,
        modelProb: row.modelProb,
        modelAt: toSecs(row.feedUpdatedAt),
        lastFanTradeAt: toSecs(fans.get(row.pubkey) ?? null),
        ...this.book.totals(row.pubkey, totals.get(row.pubkey)),
        price,
        pool: account && price !== null ? toPoolState(account) : null,
        disabled: this.watch.disabled(row.pubkey),
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

  private async balanceAlerts(snap: Snapshot): Promise<void> {
    const { params } = this.d
    if (snap.lamports < params.minSolLamports) {
      await this.d.alerts.send(
        'agent-sol',
        `Reference agent wallet holds ${Number(snap.lamports) / 1e9} SOL; fees need ${Number(params.minSolLamports) / 1e9}`,
      )
    }
    if (snap.musdc < params.minMusdc) {
      await this.d.alerts.send(
        'agent-musdc',
        `Reference agent wallet holds ${musdcText(snap.musdc)} mUSDC, under ${musdcText(params.minMusdc)}; the faucet adds 1,000 an hour`,
      )
    }
  }

  private logDecision(d: Decision): void {
    const fields = {
      market: d.market,
      gameId: d.gameId,
      price: d.price,
      model: d.model,
      gap: d.gap,
      dryRun: this.d.dryRun,
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

  /** One swap; false when it failed (counted). A swap that may still land is counted as spent. */
  private async swap(
    d: Extract<Decision, { action: 'swap' }>,
    account: MarketAccount,
    now: number,
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
      this.book.record(d.market, d.amountIn)
      this.watch.expect(d.market, {
        gameId: d.gameId,
        side: d.side,
        model: d.model,
        price: d.price,
      })
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
      if (err instanceof UnresolvedAttempt) this.book.record(d.market, d.amountIn)
      await this.failed(now, 'send', err)
      return false
    }
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
  private async claimAll(now: number): Promise<number> {
    let failures = 0
    let rows: Array<{ pubkey: string; gameId: string }>
    let infos: Array<AccountInfo<Buffer> | null>
    try {
      rows = await walletClaimableMarkets(this.d.db, this.d.wallet.toBase58())
      if (rows.length === 0) return 0
      infos = await this.accountInfos(rows.map((r) => new PublicKey(r.pubkey)))
    } catch (err) {
      await this.failed(now, 'read', err)
      return 1
    }
    for (const [i, row] of rows.entries()) {
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
        await this.failed(now, 'send', err)
      }
    }
    return failures
  }

  private async failed(now: number, kind: 'read' | 'send', err: unknown): Promise<void> {
    const error = errorSummary(err).message
    this.d.log.warn({ kind, error, streak: this.failures.count + 1 }, `agent ${kind} failed`)
    if (this.failures.fail(now)) {
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
   * included; a failed write is only logged.
   */
  private async beat(report: RoundReport, now: number): Promise<void> {
    const paused = this.failures.paused(now)
    try {
      await heartbeat(this.d.db, 'agent', {
        round: this.rounds,
        dryRun: this.d.dryRun,
        paused,
        ...(paused ? { pausedUntil: this.failures.pausedUntil } : {}),
        markets: report.decisions.length,
        sent: report.sent,
        disabled: this.watch.disabledMarkets,
      })
    } catch (err) {
      this.d.log.warn({ error: errorSummary(err).message }, 'agent heartbeat not written')
    }
  }
}
