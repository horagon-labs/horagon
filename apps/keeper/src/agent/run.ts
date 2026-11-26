// The reference agent's process (agent-main.ts; systemd user unit `horagon-agent`, started by
// hand). Off unless AGENT_ENABLED=1: then it logs "agent disabled" and returns 0 before reading
// anything else. Otherwise: the config, then the disclosure check (its wallet must be a
// team-burner entry of docs/metrics-wallets.json, or it alerts, logs and returns 0, dry run or
// not), every RPC's cluster verified (never mainnet), the keeper's database, a TxSender whose
// payer and only signer is the agent keypair, and one round every AGENT_INTERVAL_SECS until the
// stop signal. A round fails on its own and is retried on the next; a process silent for
// KEEPER_STALL_SECS exits so systemd restarts it.
import type { DbHandle } from '@horagon/db'
import { errorSummary } from '@horagon/sdk'
import type { Connection } from '@solana/web3.js'
import type { Logger } from 'pino'
import { type Alerter, logAlerter, personAlertWindow, telegramAlerter } from '../alerts'
import { BACKUP_RPC_TRIES, createLogger, makeConnection, verifyCluster } from '../config'
import { connectKeeperDb } from '../db'
import { TxSender } from '../executor'
import { faucetClaim } from '../faucet'
import { runStep } from '../loop'
import { StallGuard, watchStall } from '../stall'
import { type AgentDeps, ReferenceAgent } from './agent'
import { type AgentConfig, agentEnabled, agentLogLevel, loadAgentConfig } from './config'
import { AGENT_ROLE, teamBurnerListing, WALLETS_FILE } from './listing'

/** The log line of a refused start: the wallet is not disclosed. */
export const UNLISTED_MSG = `agent wallet is not listed as ${AGENT_ROLE} in ${WALLETS_FILE}`

export interface Connected {
  deps: AgentDeps
  close: () => Promise<void>
}

export interface RunOptions {
  /** Stops the loop after the round in progress (SIGTERM in agent-main.ts). */
  signal?: AbortSignal
  /** Replaces the log (tests). */
  log?: Logger
  /** Replaces the alerter (tests). */
  alerts?: Alerter
  /** Replaces the RPC, database and sender wiring (tests). */
  connect?: (
    cfg: AgentConfig,
    log: Logger,
    guard: StallGuard,
    alerts: Alerter,
  ) => Promise<Connected>
  /** Stops after this many rounds (tests). */
  maxRounds?: number
  repoDir?: string
}

/** Telegram when it is configured, else the log; every message starts `[<cluster>] [agent]`. */
export function agentAlerter(cfg: AgentConfig, log: Logger): Alerter {
  return cfg.telegram
    ? telegramAlerter({
        ...cfg.telegram,
        log,
        prefix: `[${cfg.cluster}] [agent]`,
        dedupeFor: personAlertWindow,
      })
    : logAlerter(log)
}

/** What connectAgent opens: the RPC connections and the database (tests replace them). */
export interface AgentWiring {
  connection: (url: string, wsUrl: string | undefined, onActivity: () => void) => Connection
  database: (url: string) => DbHandle
}

const PRODUCTION_WIRING: AgentWiring = {
  connection: (url, wsUrl, onActivity) => makeConnection(url, wsUrl, { onActivity }),
  database: (url) => connectKeeperDb(url),
}

/** The production wiring: verified RPCs, the keeper's database, the agent's own TxSender. */
export async function connectAgent(
  cfg: AgentConfig,
  log: Logger,
  guard: StallGuard,
  alerts: Alerter = agentAlerter(cfg, log),
  wiring: AgentWiring = PRODUCTION_WIRING,
): Promise<Connected> {
  const connections = await verifyCluster(
    cfg.rpcs.map((r) => wiring.connection(r.url, r.wsUrl, () => guard.touch())),
    cfg.cluster,
    {
      log,
      onBackupDown: (rpc, error) =>
        alerts.send(
          'rpc-backup-down',
          `Backup RPC ${rpc} failed the cluster check ${BACKUP_RPC_TRIES} times (${error}); the agent runs without it until it restarts.`,
        ),
    },
  )
  const { db, close } = wiring.database(cfg.databaseUrl)
  // The agent pays its own fees and signs alone: never the sponsor, never the API.
  const sender = new TxSender({ connections, payer: cfg.agent, log, alerts })
  return {
    deps: {
      db,
      sender,
      wallet: cfg.agent.publicKey,
      collateralMint: cfg.collateralMint,
      alerts,
      log,
      params: cfg.params,
      dryRun: cfg.dryRun,
      now: () => Math.floor(Date.now() / 1000),
      faucet: (wallet) => faucetClaim(cfg.faucetUrl, wallet),
      priorityMicroLamports: cfg.priorityMicroLamports,
    },
    close,
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

/** Runs the agent until `signal` aborts; the exit code. Start-up errors are thrown. */
export async function runAgent(
  env: NodeJS.ProcessEnv = process.env,
  opts: RunOptions = {},
): Promise<number> {
  if (!agentEnabled(env)) {
    ;(opts.log ?? createLogger(agentLogLevel(env), 'agent')).info('agent disabled')
    return 0
  }
  const cfg = loadAgentConfig(env, opts.repoDir ? { repoDir: opts.repoDir } : {})
  const guard = new StallGuard(cfg.stallSecs)
  const log = opts.log ?? createLogger(cfg.logLevel, 'agent', undefined, () => guard.touch())
  const alerts = opts.alerts ?? agentAlerter(cfg, log)
  // The disclosure comes first: no RPC, no database and no send (dry run included) from a
  // wallet that the pre-registered metric does not list as a team burner. Exit 0, like a
  // disabled agent, so systemd does not start it again.
  const wallet = cfg.agent.publicKey.toBase58()
  const listing = teamBurnerListing(wallet, cfg.walletsFile)
  if (!listing.listed) {
    log.error({ wallet, reason: listing.reason }, UNLISTED_MSG)
    await alerts.send(
      'agent-unlisted',
      `Reference agent not started: its wallet ${wallet} is not listed as ${AGENT_ROLE} in ${WALLETS_FILE} (${listing.reason})`,
    )
    return 0
  }
  const timer = watchStall(guard, log)
  try {
    const { deps, close } = await (opts.connect ?? connectAgent)(cfg, log, guard, alerts)
    const agent = new ReferenceAgent(deps)
    log.info(
      { wallet: cfg.agent.publicKey.toBase58(), dryRun: cfg.dryRun, cluster: cfg.cluster },
      'agent started',
    )
    let rounds = 0
    while (!opts.signal?.aborted) {
      const started = Date.now()
      const res = await runStep(log, 'agent', () => agent.round(), guard)
      if (!res.ok) log.warn({ error: errorSummary(res.error).message }, 'agent round failed')
      rounds++
      if (opts.maxRounds !== undefined && rounds >= opts.maxRounds) break
      guard.touch()
      await sleep(Math.max(0, cfg.params.intervalSecs * 1000 - (Date.now() - started)), opts.signal)
    }
    await close()
    log.info({ rounds }, 'agent stopped')
    return 0
  } finally {
    clearInterval(timer)
  }
}
