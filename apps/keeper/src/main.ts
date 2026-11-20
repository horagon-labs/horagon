// The keeper process (systemd user service `horagon-keeper` on horagon-vps). Every 5 s: one
// lifecycle tick and one indexer pass; every 10 min the sponsored-ATA watch (with
// SPONSOR_PUBKEY); hourly, in one round, the schedule, then the treasury, then the ESPN archive
// retention. Each step fails on its own, logs, and is retried on its next turn; the heartbeat
// goes out every round regardless. The RPC's cluster is verified before anything else runs.
import { connectPostgres, heartbeat } from '@horagon/db'
import { errorSummary, HoragonProgram } from '@horagon/sdk'
import { type Alerter, logAlerter, personAlertWindow, telegramAlerter } from './alerts'
import { pruneArchive } from './archive-retention'
import { watchSponsoredAtas } from './ata-watch'
import { createLogger, loadConfig, makeConnection, verifyCluster } from './config'
import { loadRatings } from './elo'
import { TxSender } from './executor'
import { espnFeed, RawArchive, USER_AGENT } from './feeds/espn'
import { loadReplayDir, replayFeed } from './feeds/replay'
import type { Feed } from './feeds/types'
import { indexOnce } from './indexer'
import { dueEvery, FailureStreak, runStep } from './loop'
import { scheduleTick } from './schedule'
import { Keeper } from './tick'
import { treasuryTick } from './treasury'

const TICK_MS = 5_000
const HOURLY_SECS = 3_600
const ATA_WATCH_SECS = 600

async function faucetClaim(url: string, wallet: string): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ wallet }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`faucet answered ${res.status}`)
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  const log = createLogger(cfg.logLevel)
  const connections = cfg.rpcs.map((r) => makeConnection(r.url, r.wsUrl))
  // Before any other RPC or DB work: never mainnet, and the cluster configured.
  await verifyCluster(connections, cfg.cluster, { log })

  const { db, close } = connectPostgres(cfg.databaseUrl)
  const alerts: Alerter = cfg.telegram
    ? telegramAlerter({
        ...cfg.telegram,
        log,
        prefix: `[${cfg.cluster}]`,
        dedupeFor: personAlertWindow,
      })
    : logAlerter(log)
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
      log.info({ signal }, 'stopping after this round')
      stopping = true
      wake?.()
    })
  }

  const hourlyDue = dueEvery(HOURLY_SECS)
  const ataWatchDue = dueEvery(ATA_WATCH_SECS)
  const tickStreak = new FailureStreak('tick')
  const indexStreak = new FailureStreak('index')
  const step = <T>(name: string, fn: () => Promise<T>) => runStep(log, name, fn)

  log.info(
    { feed: feed.name, cluster: cfg.cluster, attestor: cfg.attestor.publicKey.toBase58() },
    'keeper started',
  )
  let round = 0
  while (!stopping) {
    const started = Date.now()
    const t = now()
    if (hourlyDue(t)) {
      // One gate, in this order: the schedule sets the featured flags of the next 36 h before
      // the treasury counts their seeds. The treasury runs even when the schedule failed.
      await step('schedule', () => scheduleTick({ db, feed, ratings, now }))
      await step('treasury', () =>
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
      )
      if (archiveDir) {
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
      }
    }
    const tick = await step('tick', () => keeper.tick())
    const tickAlert = tickStreak.record(tick)
    if (tickAlert) await alerts.send(tickAlert.key, tickAlert.text)
    const index = await step('index', () =>
      indexOnce({
        db,
        connection: sender.connection,
        collateralMint: cfg.collateralMint,
        authority: program.authority,
        alerts,
        log,
        now,
        ...(cfg.sponsor ? { sponsor: cfg.sponsor } : {}),
      }),
    )
    const indexAlert = indexStreak.record(index)
    if (indexAlert) await alerts.send(indexAlert.key, indexAlert.text)
    const sponsor = cfg.sponsor
    if (sponsor && ataWatchDue(t)) {
      await step('ata-watch', () =>
        watchSponsoredAtas({ db, connection: sender.connection, sponsor, alerts, log, now }),
      )
    }
    round++
    await step('heartbeat', () =>
      heartbeat(db, 'keeper', {
        round,
        actions: tick.ok ? tick.value.length : null,
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
