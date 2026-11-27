// The keeper process (systemd user service `horagon-keeper` on horagon-vps). Two loops side by
// side, every 5 s each. The tick loop (`roundSteps`): a lifecycle tick (halts, proposals,
// finalizes), then hourly, behind one gate, the schedule, the treasury and the ESPN archive
// retention, then the heartbeat, which goes out every round regardless. The index loop
// (`indexSteps`): an indexer pass, then every 10 min the sponsored-ATA watch (with
// SPONSOR_PUBKEY); it starts once its RPCs are cluster-checked, and nothing in it ever holds a
// tick. Each step fails on its own, logs, and is retried on its next turn. SIGTERM ends each loop
// after the step in progress. Every main RPC's cluster is verified before anything else runs; a
// backup RPC that does not answer is left out. Index reads go through IndexReads: the index RPCs
// in order, then HORAGON_RPC_URL, each with its own pace, a failed read moving to the next.
import { heartbeat } from '@horagon/db'
import { errorSummary, HoragonProgram } from '@horagon/sdk'
import type { Connection } from '@solana/web3.js'
import { type Alerter, logAlerter, personAlertWindow, telegramAlerter } from './alerts'
import { pruneArchive } from './archive-retention'
import { watchSponsoredAtas } from './ata-watch'
import {
  BACKUP_RPC_TRIES,
  createLogger,
  indexEndpoints,
  loadConfig,
  makeConnection,
  rpcHost,
  verifyCluster,
} from './config'
import { connectKeeperDb } from './db'
import { loadRatings } from './elo'
import { TxSender } from './executor'
import { faucetClaim } from './faucet'
import { espnFeed, RawArchive } from './feeds/espn'
import { loadReplayDir, replayFeed } from './feeds/replay'
import type { Feed } from './feeds/types'
import { IndexPace } from './index-pace'
import { IndexReads } from './index-reads'
import { indexOnce } from './indexer'
import {
  dueEvery,
  FailureStreak,
  type IndexStep,
  indexSteps,
  PeriodicLoop,
  type RoundStep,
  roundSteps,
  runRound,
  runStep,
} from './loop'
import { evidenceUri } from './propose'
import { scheduleTick } from './schedule'
import { Balldontlie } from './second-source/balldontlie'
import { StallGuard, watchStall } from './stall'
import { type AutoProposeDeps, autoProposeNotices, Keeper } from './tick'
import { treasuryTick } from './treasury'

const TICK_MS = 5_000
const INDEX_MS = 5_000
const HOURLY_SECS = 3_600
const ATA_WATCH_SECS = 600
/**
 * An index round that has gone this long without an RPC read answering or failing is stuck (a
 * lost database response: the driver has no query timeout), and the process exits so systemd
 * restarts it, as the tick's stall guard does. It measures progress, not how long the round has
 * run: each RPC call is bounded (15 s), and a market's scan ends once the pass budget is spent.
 */
const INDEX_STALL_SECS = 300

async function main(): Promise<void> {
  const cfg = loadConfig()
  // Any log line, finished RPC call, step or heartbeat of the tick loop is activity; a silence
  // of KEEPER_STALL_SECS (a lost database response) exits the process so systemd restarts it.
  // The index loop's lines (`loop: index`) do not count: a busy index loop must not hide a stuck
  // tick.
  const guard = new StallGuard(cfg.stallSecs)
  const log = createLogger(cfg.logLevel, 'keeper', undefined, (l) => {
    if (l.bindings().loop !== 'index') guard.touch()
  })
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
      onBackupDown: async (rpc, error) => {
        await alerts.send(
          'rpc-backup-down',
          `Backup RPC ${rpc} failed the cluster check ${BACKUP_RPC_TRIES} times (${error}); the keeper runs without it until it restarts.`,
        )
      },
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
  // Auto-propose (R6): the attestor proposes checked results. Off, it says so once a start.
  const { mode, publicUrl } = cfg.autoPropose
  const autoPropose: AutoProposeDeps | undefined =
    mode !== 'off' && publicUrl
      ? {
          mode,
          evidenceUri: (gameId) => evidenceUri(publicUrl, cfg.cluster, gameId),
          secondSource: cfg.balldontlieKey ? new Balldontlie(cfg.balldontlieKey) : null,
        }
      : undefined
  const notices = autoProposeNotices(cfg.autoPropose, cfg.telegram !== null)
  if (notices.warn) log.warn(notices.warn)
  if (notices.alert) await alerts.send('auto-propose-off', notices.alert)
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
    ...(autoPropose ? { autoPropose } : {}),
  })

  let stopping = false
  let indexLoop: PeriodicLoop | undefined
  let tickLoop: PeriodicLoop | undefined
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) {
        // A second signal: the operator does not want to wait for the step in flight.
        log.warn({ signal }, 'stopping now')
        process.exit(130)
      }
      log.info({ signal }, 'stopping after the step in progress')
      stopping = true
      tickLoop?.wake()
      indexLoop?.wake()
    })
  }

  const hourlyDue = dueEvery(HOURLY_SECS)
  const ataWatchDue = dueEvery(ATA_WATCH_SECS)
  const tickStreak = new FailureStreak('tick')
  const indexStreak = new FailureStreak('index')
  const step = <T>(name: string, fn: () => Promise<T>) => runStep(log, name, fn, guard)

  // The index loop's lines do not feed the tick's stall guard; its own liveness is
  // INDEX_STALL_SECS without a read answering or failing (IndexReads `onRead`).
  const indexLog = log.child({ loop: 'index' })
  const indexStep = <T>(name: string, fn: () => Promise<T>) => runStep(indexLog, name, fn)
  watchStall(
    {
      check: () => {
        const quiet = indexLoop?.stalledMs()
        if (quiet === null || quiet === undefined || quiet < INDEX_STALL_SECS * 1000) return null
        return { stalledSecs: Math.floor(quiet / 1000), step: 'index loop' }
      },
    },
    log,
  )

  log.info(
    {
      feed: feed.name,
      cluster: cfg.cluster,
      attestor: cfg.attestor.publicKey.toBase58(),
      autoPropose: autoPropose?.mode ?? 'off',
      secondSource: autoPropose?.secondSource ? 'balldontlie' : 'off',
    },
    'keeper started',
  )

  let round = 0
  tickLoop = new PeriodicLoop({
    periodMs: TICK_MS,
    stopping: () => stopping,
    round: async () => {
      const t = now()
      let actions: number | null = null
      const run: Record<RoundStep, () => Promise<void>> = {
        tick: async () => {
          const tick = await step('tick', () => keeper.tick())
          actions = tick.ok ? tick.value.length : null
          const alert = tickStreak.record(tick)
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
              ...(cfg.sponsor ? { sponsor: cfg.sponsor } : {}),
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
      }
      // The gates are read at the start of the round; a stop skips what has not started.
      await runRound(
        roundSteps({ hourly: hourlyDue(t), archive: archiveDir !== null }),
        (s) => run[s](),
        () => stopping,
      )
      round++
      // The heartbeat is the tick's: it goes out every tick round. The index loop's rounds and
      // how long its round in progress has run ride along.
      const busy = indexLoop?.busyMs()
      await step('heartbeat', () =>
        heartbeat(db, 'keeper', {
          round,
          actions,
          feed: feed.name,
          failing: { tick: tickStreak.count, index: indexStreak.count },
          index: {
            rounds: indexLoop?.rounds ?? 0,
            busySecs: busy === null || busy === undefined ? null : Math.floor(busy / 1000),
          },
        }),
      )
    },
  })

  // The index loop: its RPCs are cluster-checked first (up to about 60 s for one that does not
  // answer), then a round every 5 s. The tick loop does not wait for any of it.
  const indexing = (async () => {
    let reads: IndexReads<Connection>
    try {
      reads = await indexReads()
    } catch (err) {
      indexLog.error({ error: errorSummary(err).message }, 'index RPCs not set up; no indexing')
      await alerts.send(
        'index-failing',
        `The keeper's index RPCs could not be set up: ${errorSummary(err).message}. Nothing is indexed until it restarts`,
      )
      return
    }
    if (stopping) return
    indexLoop = new PeriodicLoop({
      periodMs: INDEX_MS,
      stopping: () => stopping,
      round: async () => {
        const t = now()
        const sponsor = cfg.sponsor
        const run: Record<IndexStep, () => Promise<void>> = {
          index: async () => {
            const index = await indexStep('index', () =>
              indexOnce({
                db,
                reads,
                collateralMint: cfg.collateralMint,
                authority: program.authority,
                alerts,
                log: indexLog,
                now,
                ...(sponsor ? { sponsor } : {}),
              }),
            )
            const alert = indexStreak.record(index)
            if (alert) await alerts.send(alert.key, alert.text)
          },
          'ata-watch': async () => {
            if (!sponsor) return
            await indexStep('ata-watch', () =>
              watchSponsoredAtas({ db, reads, sponsor, alerts, log: indexLog, now }),
            )
          },
        }
        await runRound(
          indexSteps({ ataWatch: sponsor !== null && ataWatchDue(t) }),
          (s) => run[s](),
          () => stopping,
        )
      },
    })
    await indexLoop.run()
  })()

  await Promise.all([tickLoop.run(), indexing])
  await close()
  log.info({ round, indexRounds: indexLoop?.rounds ?? 0 }, 'keeper stopped')

  /** The index RPCs, cluster-checked, in order, then the main ones; each with its own pace. */
  async function indexReads(): Promise<IndexReads<Connection>> {
    // Index reads (indexer and ATA watch): the index RPCs that pass the cluster check, in order,
    // then HORAGON_RPC_URL (and its backup when it was verified), each on a Connection of its own
    // with its own pace; a failed read moves to the next one (index-reads.ts).
    const mainIndex = cfg.rpcs.slice(0, connections.length).map((r, i) => {
      const conn = makeConnection(r.url)
      return {
        name: i === 0 ? 'HORAGON_RPC_URL' : 'HORAGON_RPC_BACKUP_URL',
        host: rpcHost(r.url),
        connection: () => conn,
      }
    })
    const indexList = await indexEndpoints({
      specs: cfg.indexRpcs,
      main: mainIndex,
      cluster: cfg.cluster,
      log: indexLog,
      make: (spec) =>
        makeConnection(spec.url, undefined, spec.headers ? { httpHeaders: spec.headers } : {}),
      onDropped: async (name, host, reason) => {
        await alerts.send(
          `rpc-index-down:${name}`,
          `Index RPC ${name} (${host}) left out: ${reason}. Index reads use the other RPCs until the keeper restarts.`,
        )
      },
    })
    const reads = new IndexReads({
      endpoints: indexList.map((e) => ({ ...e, pace: new IndexPace({ log: indexLog }) })),
      log: indexLog,
      alerts,
      onRead: () => indexLoop?.progress(),
    })
    indexLog.info({ indexRpcs: reads.describe() }, 'index reads use these RPCs, in order')
    return reads
  }
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
