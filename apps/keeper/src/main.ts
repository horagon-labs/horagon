// The keeper process (systemd user service `horagon-keeper` on horagon-vps). Every 5 s, one
// round (`roundSteps`): a lifecycle tick and an indexer pass; then hourly, behind one gate, the
// schedule, the treasury and the ESPN archive retention; then every 10 min the sponsored-ATA
// watch (with SPONSOR_PUBKEY). Each step fails on its own, logs, and is retried on its next
// turn; the heartbeat goes out every round regardless. SIGTERM ends the round after the step in
// progress. Every RPC's cluster is verified before anything else runs; a backup RPC that does
// not answer is left out.
import { heartbeat } from '@horagon/db'
import { errorSummary, HoragonProgram } from '@horagon/sdk'
import { type Alerter, logAlerter, personAlertWindow, telegramAlerter } from './alerts'
import { pruneArchive } from './archive-retention'
import { watchSponsoredAtas } from './ata-watch'
import { BACKUP_RPC_TRIES, createLogger, loadConfig, makeConnection, verifyCluster } from './config'
import { connectKeeperDb } from './db'
import { loadRatings } from './elo'
import { TxSender } from './executor'
import { faucetClaim } from './faucet'
import { espnFeed, RawArchive } from './feeds/espn'
import { loadReplayDir, replayFeed } from './feeds/replay'
import type { Feed } from './feeds/types'
import { indexOnce } from './indexer'
import { dueEvery, FailureStreak, type RoundStep, roundSteps, runRound, runStep } from './loop'
import { scheduleTick } from './schedule'
import { StallGuard, watchStall } from './stall'
import { Keeper } from './tick'
import { treasuryTick } from './treasury'

const TICK_MS = 5_000
const HOURLY_SECS = 3_600
const ATA_WATCH_SECS = 600

async function main(): Promise<void> {
  const cfg = loadConfig()
  // Any log line, finished RPC call, step or heartbeat is activity; a silence of
  // KEEPER_STALL_SECS (a lost database response) exits the process so systemd restarts it.
  const guard = new StallGuard(cfg.stallSecs)
  const log = createLogger(cfg.logLevel, 'keeper', undefined, () => guard.touch())
  watchStall(guard, log)
  const alerts: Alerter = cfg.telegram
    ? telegramAlerter({
        ...cfg.telegram,
        log,
        prefix: `[${cfg.cluster}]`,
        dedupeFor: personAlertWindow,
      })
    : logAlerter(log)
  // Before any other RPC or DB work: never mainnet, and the cluster configured. Only the
  // verified connections are used.
  const connections = await verifyCluster(
    cfg.rpcs.map((r) => makeConnection(r.url, r.wsUrl, { onActivity: () => guard.touch() })),
    cfg.cluster,
    {
      log,
      onBackupDown: (rpc, error) =>
        alerts.send(
          'rpc-backup-down',
          `Backup RPC ${rpc} failed the cluster check ${BACKUP_RPC_TRIES} times (${error}); the keeper runs without it until it restarts.`,
        ),
    },
  )

  const { db, close } = connectKeeperDb(cfg.databaseUrl)
  const sender = new TxSender({ connections, payer: cfg.attestor, log, alerts })
  const program = new HoragonProgram({ collateralMint: cfg.collateralMint })
  const ratings = await loadRatings(cfg.eloFile)
  const now = () => Math.floor(Date.now() / 1000)
  const archiveDir = cfg.feed.kind === 'espn' ? cfg.feed.archiveDir : null
  const feed: Feed =
    cfg.feed.kind === 'espn'
      ? espnFeed({
          archive: new RawArchive(cfg.feed.archiveDir),
          onArchiveError: (cause) => {
            const error = errorSummary(cause).message
            log.warn({ error }, 'ESPN archive write failed')
            void alerts.send('archive', `The raw ESPN archive could not be written: ${error}`)
          },
        })
      : replayFeed(await loadReplayDir(cfg.feed.dir), {
          tag: cfg.feed.tag,
          tipoff: cfg.feed.tipoff,
          now: () => new Date(),
          speed: cfg.feed.speed,
        })
  const keeper = new Keeper({
    db,
    sender,
    program,
    attestor: cfg.attestor,
    feed,
    alerts,
    log,
    now,
    timings: cfg.timings,
    seeds: cfg.seeds,
    sigma: ratings.sigma,
    priority: cfg.priority,
  })

  let stopping = false
  let wake: (() => void) | undefined
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) {
        // A second signal: the operator does not want to wait for the step in flight.
        log.warn({ signal }, 'stopping now')
        process.exit(130)
      }
      log.info({ signal }, 'stopping after the step in progress')
      stopping = true
      wake?.()
    })
  }

  const hourlyDue = dueEvery(HOURLY_SECS)
  const ataWatchDue = dueEvery(ATA_WATCH_SECS)
  const tickStreak = new FailureStreak('tick')
  const indexStreak = new FailureStreak('index')
  const step = <T>(name: string, fn: () => Promise<T>) => runStep(log, name, fn, guard)

  log.info(
    { feed: feed.name, cluster: cfg.cluster, attestor: cfg.attestor.publicKey.toBase58() },
    'keeper started',
  )
  let round = 0
  while (!stopping) {
    const started = Date.now()
    const t = now()
    const sponsor = cfg.sponsor
    let actions: number | null = null
    const run: Record<RoundStep, () => Promise<void>> = {
      tick: async () => {
        const tick = await step('tick', () => keeper.tick())
        actions = tick.ok ? tick.value.length : null
        const alert = tickStreak.record(tick)
        if (alert) await alerts.send(alert.key, alert.text)
      },
      index: async () => {
        const index = await step('index', () =>
          indexOnce({
            db,
            connection: sender.connection,
            collateralMint: cfg.collateralMint,
            authority: program.authority,
            alerts,
            log,
            now,
            ...(sponsor ? { sponsor } : {}),
          }),
        )
        const alert = indexStreak.record(index)
        if (alert) await alerts.send(alert.key, alert.text)
      },
      schedule: async () =>
        void (await step('schedule', () => scheduleTick({ db, feed, ratings, now }))),
      // Runs even when the schedule failed.
      treasury: async () =>
        void (await step('treasury', () =>
          treasuryTick({
            db,
            sender,
            program,
            attestor: cfg.attestor,
            alerts,
            log,
            seeds: cfg.seeds,
            now,
            faucet: (wallet) => faucetClaim(cfg.faucetUrl, wallet),
            priorityMicroLamports: cfg.priority.normal,
          }),
        )),
      archive: async () => {
        if (!archiveDir) return
        const pruned = await step('archive', () => pruneArchive(archiveDir, t))
        if (pruned.ok && (pruned.value.gzipped.length > 0 || pruned.value.deleted.length > 0)) {
          log.info(pruned.value, 'ESPN archive retention')
        }
        if (!pruned.ok) {
          await alerts.send(
            'archive',
            `ESPN archive retention failed: ${errorSummary(pruned.error).message}`,
          )
        }
      },
      'ata-watch': async () => {
        if (!sponsor) return
        await step('ata-watch', () =>
          watchSponsoredAtas({ db, connection: sender.connection, sponsor, alerts, log, now }),
        )
      },
    }
    // The gates are read at the start of the round; a stop skips what has not started.
    const steps = roundSteps({
      hourly: hourlyDue(t),
      archive: archiveDir !== null,
      ataWatch: sponsor !== null && ataWatchDue(t),
    })
    await runRound(
      steps,
      (s) => run[s](),
      () => stopping,
    )
    round++
    await step('heartbeat', () =>
      heartbeat(db, 'keeper', {
        round,
        actions,
        feed: feed.name,
        failing: { tick: tickStreak.count, index: indexStreak.count },
      }),
    )
    if (stopping) break
    await new Promise<void>((r) => {
      const timer = setTimeout(r, Math.max(0, TICK_MS - (Date.now() - started)))
      wake = () => {
        clearTimeout(timer)
        r()
      }
    })
  }
  await close()
  log.info({ round }, 'keeper stopped')
}

main().then(
  () => process.exit(0),
  (err) => {
    // Start-up failures only (configuration, cluster refusal, ratings file): the loop never
    // throws. The message is redacted: a URL in it may carry an RPC key.
    console.error(`keeper failed to start: ${errorSummary(err).message}`)
    process.exit(1)
  },
)
