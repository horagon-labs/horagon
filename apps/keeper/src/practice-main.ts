// The Practice process (R8): systemd user unit `horagon-practice` on the VPS, beside the keeper,
// with the same .env.keeper and the same attestor. Every 5 s one round (`PracticeArena`): its
// own Keeper ticks the PRACTICE games, and at 10, 12, 14, 16, 18 and 20:00 UTC a new run replays
// a recorded game at 6x once its guards pass. It never touches an NBA game, and the main keeper
// never touches a PRACTICE one. It refuses to start without PRACTICE_SOURCE_URL or
// HORAGON_PUBLIC_URL. SIGTERM ends the round in progress; a second signal exits at once.

import { heartbeat } from '@horagon/db'
import { errorSummary, HoragonProgram } from '@horagon/sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import type { PublicKey } from '@solana/web3.js'
import { type Alerter, logAlerter, telegramAlerter } from './alerts'
import { BACKUP_RPC_TRIES, createLogger, makeConnection, verifyCluster } from './config'
import { connectKeeperDb } from './db'
import { loadRatings } from './elo'
import { TxSender } from './executor'
import { loadReplayDir } from './feeds/replay'
import { FailureStreak, runStep } from './loop'
import { loadPracticeConfig, practiceAlertWindow } from './practice/config'
import { PracticeArena, type PracticeRound, practiceKeeper } from './practice/round'
import { PRACTICE_FIXTURES_DIR, PracticeFeed } from './practice/runs'
import { evidenceUri } from './propose'
import { StallGuard, watchStall } from './stall'
import { isMissingAccount } from './treasury'

const TICK_MS = 5_000

async function main(): Promise<void> {
  const cfg = loadPracticeConfig()
  const k = cfg.keeper
  const guard = new StallGuard(k.stallSecs)
  const log = createLogger(k.logLevel, 'practice', undefined, () => guard.touch())
  watchStall(guard, log)
  const alerts: Alerter = k.telegram
    ? telegramAlerter({
        ...k.telegram,
        log,
        prefix: `[${k.cluster} practice]`,
        dedupeFor: practiceAlertWindow,
      })
    : logAlerter(log)
  const connections = await verifyCluster(
    k.rpcs.map((r) => makeConnection(r.url, r.wsUrl, { onActivity: () => guard.touch() })),
    k.cluster,
    {
      log,
      onBackupDown: async (rpc, error) => {
        log.warn({ rpc, error, tries: BACKUP_RPC_TRIES }, 'backup RPC left out')
      },
    },
  )
  const { db, close } = connectKeeperDb(k.databaseUrl)
  const sender = new TxSender({ connections, payer: k.attestor, log, alerts })
  const program = new HoragonProgram({ collateralMint: k.collateralMint })
  const ratings = await loadRatings(k.eloFile)
  const fixtures = await loadReplayDir(PRACTICE_FIXTURES_DIR)
  const now = () => Math.floor(Date.now() / 1000)
  const feed = new PracticeFeed({ fixtures, now: () => new Date(), sourceBase: cfg.sourceBase })
  const keeper = practiceKeeper({
    db,
    sender,
    program,
    attestor: k.attestor,
    feed,
    alerts,
    log,
    now,
    sigma: ratings.sigma,
    priority: k.priority,
    evidenceUri: (gameId) => evidenceUri(cfg.publicUrl, k.cluster, gameId),
  })
  const conn = sender.connection
  // A token account that does not exist holds nothing.
  const balanceOf = (ata: PublicKey) =>
    conn.getTokenAccountBalance(ata, 'confirmed').then(
      (r) => BigInt(r.value.amount),
      (err: unknown) => {
        if (isMissingAccount(err)) return 0n
        throw err
      },
    )
  const arena = new PracticeArena({
    db,
    keeper,
    feed,
    alerts,
    log,
    now,
    fixtures,
    ratings,
    nbaSeeds: k.seeds,
    solFloorLamports: cfg.solFloorLamports,
    balances: {
      attestorLamports: async () =>
        BigInt(await conn.getBalance(k.attestor.publicKey, 'confirmed')),
      seedFunds: async () => {
        const [treasury, wallet] = await Promise.all([
          balanceOf(program.treasury),
          balanceOf(getAssociatedTokenAddressSync(k.collateralMint, k.attestor.publicKey)),
        ])
        return treasury + wallet
      },
    },
  })

  let stopping = false
  let wake: (() => void) | undefined
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) process.exit(130)
      log.info({ signal }, 'stopping after the round in progress')
      stopping = true
      wake?.()
    })
  }

  const streak = new FailureStreak('practice')
  log.info(
    { cluster: k.cluster, attestor: k.attestor.publicKey.toBase58(), recordings: fixtures.length },
    'practice started',
  )
  let round = 0
  let last: PracticeRound | null = null
  while (!stopping) {
    const started = Date.now()
    const res = await runStep(log, 'practice', () => arena.round(), guard)
    if (res.ok) last = res.value
    const alert = streak.record(res)
    if (alert) await alerts.send(alert.key, alert.text)
    round++
    await runStep(
      log,
      'heartbeat',
      () =>
        heartbeat(db, 'practice', {
          round,
          nextAt: last?.nextAt ?? null,
          skipped: last?.skipped ?? null,
          failing: streak.count,
        }),
      guard,
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
  log.info({ round }, 'practice stopped')
}

main().then(
  () => process.exit(0),
  (err) => {
    // Start-up failures only; the message is redacted (an RPC URL may carry a key).
    console.error(`practice failed to start: ${errorSummary(err).message}`)
    process.exit(1)
  },
)
