#!/usr/bin/env -S npx tsx
// `horagon-ops`: the commands a person runs (spec 13, 16); `horagon-ops help` prints USAGE.
// Guardian commands sign with `.keys/guardian.json`, admin commands with the upgrade authority
// `.keys/deployer.json`; `--keypair <path>` picks another file. Relative key paths resolve from
// the repo root. Every command that connects to an RPC checks its cluster first (never
// mainnet). A send that ends unresolved is reported as unknown (exit 3) and never retried
// here: run `status` first. A `propose` re-run sends the evidence the earlier one stored, or
// refuses (propose-evidence.ts).
import { parseArgs } from 'node:util'
import {
  connectPostgres,
  type Db,
  FLAG_NAMES,
  getDraft,
  getGame,
  getHeartbeat,
  listGames,
  logOps,
  readFlags,
  setDraftState,
  setFeatured,
  setFlag,
  setWalletKind,
  updateMarket,
} from '@horagon/db'
import {
  authorityOutcomeAtaIxs,
  DEVNET_MUSDC_MINT,
  errorSummary,
  GameIdSchema,
  HEAVY_IX_COMPUTE_UNITS,
  HoragonProgram,
  LIGHT_IX_COMPUTE_UNITS,
  MAX_EVIDENCE_URI_LEN,
} from '@horagon/sdk'
import { toHex } from '@horagon/sdk/evidence'
import { type Connection, PublicKey, SystemProgram } from '@solana/web3.js'
import { type Alerter, logAlerter, personAlertWindow, telegramAlerter } from '../alerts'
import {
  assertCluster,
  type Cluster,
  createLogger,
  loadKeypair,
  makeConnection,
  resolveKeyPath,
  rpcEndpoints,
  telegramSettings,
  timingsFrom,
} from '../config'
import { buildEvidence, type SealedEvidence, sealEvidence } from '../evidence'
import { ProgramFailure, type SendResult, TxSender } from '../executor'
import { periodsConsistent } from '../feeds/types'
import {
  boxScoreUrl,
  disputeWindowArg,
  flagArgs,
  gameDateArg,
  noticeUrl,
  opsArgv,
  opsErrorReport,
  parsePeriods,
  parseScore,
  publicKeyArg,
  signatureIn,
  solToLamports,
} from './args'
import { backfillBotMemo } from './backfill-bot-memo'
import { DEPLOY_CHECK_BACK_SECS, deployBlockers, deployCheckLines } from './deploy-check'
import {
  type AttemptLookups,
  chooseAndStoreEvidence,
  type DraftWish,
  endAttempt,
  nextDraft,
  type ProposeAttempt,
  pendingAttempt,
  proposeStatusLine,
  readProposeRecord,
  startAttempt,
  writeProposeRecord,
} from './propose-evidence'
import { watchdogRun } from './watchdog'

const USAGE = `usage: horagon-ops <command>
  status [--date 2026-11-24]
  propose <gameId> --box-score <url> --score <home>-<away> [--periods 30-25,...] [--replace-evidence]
  propose <gameId> --postponed --notice <url> [--replace-evidence]
  challenge <gameId>
  halt <gameId>
  featured <gameDate> <gameId>...
  init-config --guardian <pubkey> [--guardian2 <pubkey>] [--window 900]
  pause | resume
  fund-authority <sol>
  team <pubkey>...
  flag on|off <FLAG_NAME>
  backfill-bot-memo
  watchdog
  deploy-check
  help | --help | -h
options:
  --keypair <path>    sign with another key file (a relative path starts at the repo root)
  --replace-evidence  let propose overwrite the evidence an earlier propose stored from other
                      inputs. Only for after the earlier propose's signature has expired: it is
                      refused while anything sent earlier may still land.`

const OPTIONS = {
  date: { type: 'string' },
  'box-score': { type: 'string' },
  score: { type: 'string' },
  periods: { type: 'string' },
  postponed: { type: 'boolean' },
  notice: { type: 'string' },
  guardian: { type: 'string' },
  guardian2: { type: 'string' },
  window: { type: 'string' },
  keypair: { type: 'string' },
  'replace-evidence': { type: 'boolean' },
} as const

const parse = (argv: string[]) =>
  parseArgs({ args: opsArgv(argv), allowPositionals: true, options: OPTIONS })
type Values = ReturnType<typeof parse>['values']

const env = process.env
const log = createLogger(env.LOG_LEVEL ?? 'warn', 'ops')

function need(name: string): string {
  const v = env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

function cluster(): Cluster {
  const c = env.HORAGON_CLUSTER ?? 'devnet'
  if (c !== 'devnet' && c !== 'localnet')
    throw new Error('HORAGON_CLUSTER must be devnet or localnet')
  return c
}

/** The keeper's both-or-neither rule: a half-set Telegram pair exits 1, never silently. */
function alerter(): Alerter {
  const telegram = telegramSettings(env)
  return telegram
    ? telegramAlerter({
        ...telegram,
        log,
        prefix: `[${cluster()}]`,
        dedupeFor: personAlertWindow,
      })
    : logAlerter(log)
}

const db = () => connectPostgres(need('DATABASE_URL'), { max: 2 })

async function setup(defaultKey: string, keypair: string | undefined) {
  const backup = env.HORAGON_RPC_BACKUP_URL
  // Checks every configured URL (mainnet, RPC_WS_URLS); ops sends through the primary only.
  const [rpc] = rpcEndpoints(
    [need('HORAGON_RPC_URL'), ...(backup ? [backup] : [])],
    env.RPC_WS_URLS,
  )
  if (!rpc) throw new Error('HORAGON_RPC_URL is not set')
  const alerts = alerter()
  const signer = loadKeypair(resolveKeyPath(keypair ?? defaultKey))
  const connection = makeConnection(rpc.url, rpc.wsUrl)
  // Before any other RPC or DB work: never mainnet, and the cluster configured.
  await assertCluster(connection, cluster())
  const program = new HoragonProgram({
    collateralMint: publicKeyArg(
      'HORAGON_COLLATERAL_MINT',
      env.HORAGON_COLLATERAL_MINT ?? DEVNET_MUSDC_MINT.toBase58(),
    ),
  })
  const sender = new TxSender({ connections: [connection], payer: signer, log, alerts })
  return { connection, signer, program, sender, ...db() }
}

type Ctx = Awaited<ReturnType<typeof setup>>

async function marketOf(db: Db, gameId: string) {
  if (!GameIdSchema.safeParse(gameId).success) throw new Error(`"${gameId}" is not a game id`)
  const game = await getGame(db, gameId)
  if (!game) throw new Error(`no game ${gameId}`)
  const market = game.markets.find((m) => m.kind === 0)
  if (!market) throw new Error(`${gameId} has no winner market`)
  return { game, market, marketId: BigInt(market.marketId) }
}

async function chainNow(connection: Connection): Promise<number> {
  const t = await connection.getBlockTime(await connection.getSlot('confirmed'))
  if (t === null) throw new Error('could not read the chain clock')
  return t
}

/** The API's base URL for the evidence link: https (http only on localnet), no trailing slash. */
function publicBaseUrl(): string {
  const raw = need('HORAGON_PUBLIC_URL')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('HORAGON_PUBLIC_URL is not a URL')
  }
  const http = url.protocol === 'http:' && cluster() === 'localnet'
  if (url.protocol !== 'https:' && !http) throw new Error('HORAGON_PUBLIC_URL must be https')
  return url.href.replace(/\/+$/, '')
}

const PROPOSABLE: ReadonlySet<string> = new Set(['open', 'halted', 'challenged'])

type ProposeArgs = { uri: string; replace: boolean } & (
  | { status: 'postponed'; notice: string }
  | {
      status: 'final'
      box: ReturnType<typeof boxScoreUrl>
      home: number
      away: number
      periods: Array<[number, number]> | null
    }
)

/** Every `propose` flag, checked before anything connects. */
function proposeArgs(gameId: string, v: Values): ProposeArgs {
  if (!GameIdSchema.safeParse(gameId).success) throw new Error(`"${gameId}" is not a game id`)
  const uri = `${publicBaseUrl()}/api/v1/evidence/${gameId}/winner`
  if (uri.length > MAX_EVIDENCE_URI_LEN)
    throw new Error(`the evidence URI is longer than ${MAX_EVIDENCE_URI_LEN} characters: ${uri}`)
  const replace = v['replace-evidence'] === true
  if (v.postponed) {
    if (v['box-score'] || v.score || v.periods) throw new Error('--postponed takes --notice only')
    return { uri, replace, status: 'postponed', notice: noticeUrl(v.notice) }
  }
  if (v.notice) throw new Error('--notice goes with --postponed')
  const box = boxScoreUrl(v['box-score'])
  const [home, away] = parseScore(v.score ?? '')
  const periods = v.periods ? parsePeriods(v.periods) : null
  if (periods && !periodsConsistent({ periods, homeScore: home, awayScore: away }))
    throw new Error(`--periods do not add up to ${home}-${away}`)
  return { uri, replace, status: 'final', box, home, away, periods }
}

async function propose(c: Ctx, gameId: string, a: ProposeArgs): Promise<void> {
  const { uri } = a
  const { game, market, marketId } = await marketOf(c.db, gameId)
  const gm = await c.program.fetchGameMarket(c.connection, marketId)
  if (!gm || !PROPOSABLE.has(gm.status)) {
    throw new Error(`${gameId}: market is ${gm?.status ?? 'missing'}, nothing to propose`)
  }
  const now = await chainNow(c.connection)
  if (now < gm.endTs) {
    throw new Error(
      `${gameId}: proposing opens at end_ts ${new Date(gm.endTs * 1000).toISOString()}`,
    )
  }
  // The draft this run proposes (nextDraft), built in memory. `newDraft` is written only once
  // `chooseAndStoreEvidence` accepts the run: a refused run leaves the stored draft, and the
  // evidence rebuilt from it, as they were.
  const prior = await getDraft(c.db, gameId)
  let confirmUrl: string
  let confirmSource: string
  let wish: DraftWish
  if (a.status === 'postponed') {
    confirmUrl = a.notice
    confirmSource = 'notice'
    wish = { gameId, status: 'postponed', notice: a.notice }
  } else {
    if (a.box.warning) console.warn(`warning: ${a.box.warning}`)
    confirmUrl = a.box.url
    confirmSource = a.box.source
    wish = {
      gameId,
      status: 'final',
      home: a.home,
      away: a.away,
      periods: a.periods,
      sourceUrl: a.box.url,
    }
  }
  const { draft, newDraft } = nextDraft(prior, wish, new Date())
  const round = gm.challengeCount
  const record = await readProposeRecord(c.db, gameId)
  const startedAt = Math.floor(Date.now() / 1000)
  let started: ReturnType<typeof startAttempt> | undefined
  // A re-run sends the evidence already stored, or refuses (propose-evidence.ts). Evidence,
  // draft and the attempt's record commit together, before the send: a later --replace-evidence
  // must know the attempt may land, and the hash on chain must be fetchable.
  const { sealed, write } = await chooseAndStoreEvidence(c.db, {
    gameId,
    newDraft,
    seal: (confirmedAt) =>
      sealEvidence(buildEvidence({ game, draft, kind: 0, confirmUrl, confirmSource, confirmedAt })),
    now: new Date(),
    replace: a.replace,
    pending: () => pendingAttempt(record, round, attemptLookups(c.connection), startedAt),
    record: (s) => {
      started = startAttempt(record, s.hashHex, round, startedAt)
      return started.record
    },
  })
  if (!started) throw new Error('internal: the propose record was not built')
  const attempt = started
  if (!write)
    console.log(`sending the evidence an earlier propose stored (sha256 ${sealed.hashHex})`)
  const ended = async (end: Omit<ProposeAttempt, 'at' | 'ended'>) => {
    const last = endAttempt(attempt.record, attempt.index, {
      ...end,
      ended: Math.floor(Date.now() / 1000),
    })
    await writeProposeRecord(c.db, gameId, last).catch((err) =>
      console.warn(`warning: the propose record was not updated: ${errorSummary(err).message}`),
    )
  }
  let res: SendResult
  try {
    res = await sendPropose(c, gameId, marketId, sealed, uri)
  } catch (err) {
    if (err instanceof ProgramFailure) {
      // Rejected: the sender proves nothing it sent is still in flight before it throws this.
      await ended({ state: 'failed' })
    } else {
      // Unresolved, or gave up: whatever was sent took its blockhash before this height read,
      // so it cannot land once the chain is ATTEMPT_EXPIRY_BLOCKS past it.
      const sig = signatureIn(errorSummary(err).message)
      const height = await c.connection.getBlockHeight('confirmed').catch(() => undefined)
      await ended({
        state: 'unresolved',
        ...(sig ? { sig } : {}),
        ...(height !== undefined ? { height } : {}),
      })
    }
    throw err
  }
  await ended({ state: 'landed', ...(res.signature ? { sig: res.signature } : {}) })
  console.log(
    `proposed ${sealed.evidence.outcome.toUpperCase()} for ${game.away}@${game.home} (${res.signature ?? 'already on chain'})`,
  )
  console.log(`evidence ${uri}  sha256 ${sealed.hashHex}`)
  await setDraftState(c.db, gameId, { state: 'proposed' })
  await updateMarket(c.db, market.pubkey, {
    status: 'proposed',
    evidenceHash: sealed.hashHex,
    ...(res.signature ? { proposeSig: res.signature } : {}),
  })
  await logOps(c.db, {
    actor: 'guardian',
    action: 'propose',
    gameId,
    market: market.pubkey,
    sig: res.signature,
    detail: { outcome: sealed.evidence.outcome, hash: sealed.hashHex },
  })
}

/** What the chain says about an earlier propose attempt. */
const attemptLookups = (connection: Connection): AttemptLookups => ({
  status: async (sig) =>
    (await connection.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0] ??
    null,
  blockHeight: () => connection.getBlockHeight('confirmed'),
})

function sendPropose(
  c: Ctx,
  gameId: string,
  marketId: bigint,
  sealed: SealedEvidence,
  uri: string,
): Promise<SendResult> {
  return c.sender.send({
    label: `propose ${gameId}`,
    instructions: [
      ...authorityOutcomeAtaIxs(c.signer.publicKey, {
        marketId,
        programId: c.program.programId,
        pmAmmProgramId: c.program.pmAmmProgramId,
      }),
      c.program.ix.proposeResult({
        signer: c.signer.publicKey,
        marketId,
        outcome: sealed.evidence.outcome,
        evidenceHash: sealed.hash,
        evidenceUri: uri,
      }),
    ],
    computeUnits: LIGHT_IX_COMPUTE_UNITS,
    priorityMicroLamports: 10_000,
    // Only this proposal counts: proposed, with this evidence hash.
    isDone: async () => {
      const after = await c.program.fetchGameMarket(c.connection, marketId)
      return after?.status === 'proposed' && toHex(after.evidenceHash) === sealed.hashHex
    },
  })
}

async function challenge(c: Ctx, gameId: string): Promise<void> {
  const { market, marketId } = await marketOf(c.db, gameId)
  const gm = await c.program.fetchGameMarket(c.connection, marketId)
  if (gm?.status !== 'proposed') {
    throw new Error(
      `${gameId}: market is ${gm?.status ?? 'missing'}; only a proposal can be challenged`,
    )
  }
  const before = gm.challengeCount
  const res = await c.sender.send({
    label: `challenge ${gameId}`,
    instructions: [c.program.ix.challenge({ guardian: c.signer.publicKey, marketId })],
    computeUnits: LIGHT_IX_COMPUTE_UNITS,
    priorityMicroLamports: 100_000,
    isDone: async () => {
      const after = await c.program.fetchGameMarket(c.connection, marketId)
      return after !== null && after.challengeCount > before
    },
  })
  console.log(
    `challenged ${gameId} (${res.signature ?? 'already on chain'}); the keeper drafts again from the feed`,
  )
  await setDraftState(c.db, gameId, { state: 'rejected' })
  // Status only: the keeper's sync copies the count and sends the round's challenge alert.
  await updateMarket(c.db, market.pubkey, { status: 'challenged' })
  await logOps(c.db, {
    actor: 'guardian',
    action: 'challenge',
    gameId,
    market: market.pubkey,
    sig: res.signature,
    detail: {},
  })
}

async function halt(c: Ctx, gameId: string): Promise<void> {
  const { market, marketId } = await marketOf(c.db, gameId)
  const gm = await c.program.fetchGameMarket(c.connection, marketId)
  if (!gm) throw new Error(`${gameId}: no GameMarket on chain`)
  if (gm.status !== 'open') {
    console.log(`${gameId} is already ${gm.status}; nothing to halt`)
    return
  }
  const res = await c.sender.send({
    label: `halt ${gameId} (guardian)`,
    instructions: c.program.ix.halt({ signer: c.signer.publicKey, marketId }, c.signer.publicKey),
    computeUnits: HEAVY_IX_COMPUTE_UNITS,
    priorityMicroLamports: 200_000,
    // A null read (a lagging RPC) proves nothing: only a GameMarket seen not open is halted.
    isDone: async () => {
      const after = await c.program.fetchGameMarket(c.connection, marketId)
      return after !== null && after.status !== 'open'
    },
  })
  console.log(`halted ${gameId} (${res.signature ?? 'already on chain'})`)
  await updateMarket(c.db, market.pubkey, {
    status: 'halted',
    ...(res.signature ? { haltSig: res.signature } : {}),
  })
  await logOps(c.db, {
    actor: 'guardian',
    action: 'halt',
    gameId,
    market: market.pubkey,
    sig: res.signature,
    detail: {},
  })
}

interface InitConfigArgs {
  attestor: PublicKey
  guardians: [PublicKey, PublicKey]
  disputeWindowSecs: number
}

function initConfigArgs(v: Values): InitConfigArgs {
  return {
    attestor: publicKeyArg('ATTESTOR_PUBKEY', need('ATTESTOR_PUBKEY')),
    guardians: [
      publicKeyArg('--guardian', v.guardian),
      v.guardian2 ? publicKeyArg('--guardian2', v.guardian2) : PublicKey.default,
    ],
    disputeWindowSecs: disputeWindowArg(v.window),
  }
}

async function initConfig(c: Ctx, a: InitConfigArgs): Promise<void> {
  const { attestor, guardians, disputeWindowSecs } = a
  if (await c.program.fetchConfig(c.connection)) {
    console.log(`config ${c.program.config.toBase58()} is already initialized; nothing sent`)
    return
  }
  const res = await c.sender.send({
    label: 'initialize_config',
    instructions: [
      c.program.ix.initializeConfig({
        admin: c.signer.publicKey,
        attestor,
        guardians,
        disputeWindowSecs,
      }),
    ],
    computeUnits: LIGHT_IX_COMPUTE_UNITS,
    priorityMicroLamports: 10_000,
    isDone: async () => (await c.program.fetchConfig(c.connection)) !== null,
  })
  console.log(`config ${c.program.config.toBase58()} (${res.signature ?? 'already on chain'})`)
  await logOps(c.db, {
    actor: 'admin',
    action: 'init-config',
    sig: res.signature,
    detail: {
      attestor: attestor.toBase58(),
      guardians: guardians.map((g) => g.toBase58()),
      disputeWindowSecs,
    },
  })
}

async function setPaused(c: Ctx, paused: boolean): Promise<void> {
  const config = await c.program.fetchConfig(c.connection)
  if (!config) throw new Error('the Config is not initialized: run init-config')
  if (config.creationPaused === paused) {
    console.log(`creation is already ${paused ? 'paused' : 'running'}; nothing sent`)
    return
  }
  const res = await c.sender.send({
    label: paused ? 'pause creation' : 'resume creation',
    instructions: [
      c.program.ix.updateConfig({ admin: c.signer.publicKey, creationPaused: paused }),
    ],
    computeUnits: LIGHT_IX_COMPUTE_UNITS,
    priorityMicroLamports: 10_000,
    isDone: async () => (await c.program.fetchConfig(c.connection))?.creationPaused === paused,
  })
  console.log(`creation ${paused ? 'paused' : 'resumed'} (${res.signature ?? 'already on chain'})`)
  await logOps(c.db, {
    actor: 'admin',
    action: paused ? 'pause' : 'resume',
    sig: res.signature,
    detail: {},
  })
}

/**
 * Sends SOL to the Authority PDA, which pays the rent of every market it creates (spec 6.3,
 * about 0.0354 SOL each). `claim_winnings` later closes the Authority's YES/NO ATAs, so about
 * 0.003 SOL of rent per market comes back to the Authority PDA. At most 10 SOL per call
 * (`solToLamports`' max), checked before anything connects.
 */
async function fundAuthority(c: Ctx, amount: string, lamports: number): Promise<void> {
  const res = await c.sender.send({
    label: 'fund authority',
    instructions: [
      SystemProgram.transfer({
        fromPubkey: c.signer.publicKey,
        toPubkey: c.program.authority,
        lamports,
      }),
    ],
    computeUnits: 10_000,
    priorityMicroLamports: 10_000,
  })
  console.log(
    `sent ${amount} SOL to the Authority ${c.program.authority.toBase58()} (${res.signature})`,
  )
  await logOps(c.db, {
    actor: 'admin',
    action: 'fund-authority',
    sig: res.signature,
    detail: { lamports },
  })
}

async function status(db: Db, date: string | undefined): Promise<void> {
  const from = date
    ? new Date(`${gameDateArg(date, '--date')}T00:00:00Z`)
    : new Date(Date.now() - 12 * 3600_000)
  const to = new Date(from.getTime() + 48 * 3600_000)
  const hb = await getHeartbeat(db, 'keeper')
  console.log(
    hb
      ? `keeper heartbeat ${Math.round((Date.now() - hb.ts.getTime()) / 1000)} s ago ${JSON.stringify(hb.info)}`
      : 'keeper heartbeat: none',
  )
  const chain = statusChain()
  for (const g of await listGames(db, { from, to })) {
    const m = g.markets.find((x) => x.kind === 0)
    const d = await getDraft(db, g.id)
    console.log(
      [
        g.id,
        `${g.away}@${g.home}`,
        g.scheduledTipoff.toISOString(),
        g.status,
        `${g.awayScore}-${g.homeScore}`,
        g.featured ? 'featured' : '',
        m ? `market:${m.status}` : 'no market',
        m && m.challengeCount > 0 ? `challenges:${m.challengeCount}` : '',
        d ? `draft:${d.status}/${d.state}` : '',
      ]
        .filter(Boolean)
        .join('  '),
    )
    const record = await readProposeRecord(db, g.id)
    if (record === null) continue
    // The same check `propose --replace-evidence` makes. The chain is read for the signature,
    // the block height and the challenge round; when it cannot be, the check says so (and a
    // record that needs the chain reads "may still land").
    const round = m ? await chain.round(m.marketId, m.challengeCount) : 0
    const line = await proposeStatusLine(
      record,
      round,
      chain.lookups,
      Math.floor(Date.now() / 1000),
    )
    if (line) console.log(line)
  }
}

/**
 * What `status` reads from the chain for a propose record, connected only when one is needed.
 * Without HORAGON_RPC_URL the lookups fail, which the pending check treats as "may still land".
 */
function statusChain(): {
  lookups: AttemptLookups
  round(marketId: string, dbRound: number): Promise<number>
} {
  let connection: Promise<Connection> | undefined
  const connect = (): Promise<Connection> => {
    connection ??= (async () => {
      const [rpc] = rpcEndpoints([need('HORAGON_RPC_URL')], env.RPC_WS_URLS)
      if (!rpc) throw new Error('HORAGON_RPC_URL is not set')
      const conn = makeConnection(rpc.url, rpc.wsUrl)
      await assertCluster(conn, cluster())
      return conn
    })()
    return connection
  }
  return {
    lookups: {
      status: async (sig) => attemptLookups(await connect()).status(sig),
      blockHeight: async () => attemptLookups(await connect()).blockHeight(),
    },
    // The challenge round on chain; the indexed one when the chain cannot be read.
    round: async (marketId, dbRound) => {
      try {
        const program = new HoragonProgram({
          collateralMint: publicKeyArg(
            'HORAGON_COLLATERAL_MINT',
            env.HORAGON_COLLATERAL_MINT ?? DEVNET_MUSDC_MINT.toBase58(),
          ),
        })
        const gm = await program.fetchGameMarket(await connect(), BigInt(marketId))
        return gm ? gm.challengeCount : dbRound
      } catch {
        return dbRound
      }
    },
  }
}

/** Runs `body` with the DB, closing it whatever happens. */
async function withDb(body: (db: Db) => Promise<void>): Promise<void> {
  const h = db()
  try {
    await body(h.db)
  } finally {
    await h.close()
  }
}

async function run(argv: string[]): Promise<void> {
  const { positionals, values } = parse(argv)
  const [command, ...args] = positionals
  const guardianKey = '.keys/guardian.json'
  const adminKey = '.keys/deployer.json'
  switch (command) {
    case 'status':
      return withDb((db) => status(db, values.date))
    case 'featured': {
      const [rawDate, ...ids] = args
      if (!rawDate || ids.length === 0 || ids.length > 4)
        throw new Error('usage: featured <gameDate> <gameId>... (1 to 4)')
      const date = gameDateArg(rawDate, 'gameDate')
      for (const id of ids)
        if (!GameIdSchema.safeParse(id).success) throw new Error(`"${id}" is not a game id`)
      return withDb(async (db) => {
        await setFeatured(db, date, ids)
        await logOps(db, { actor: 'admin', action: 'featured', detail: { date, ids } })
        console.log(`featured on ${date}: ${ids.join(', ')}`)
      })
    }
    case 'team': {
      // Team wallets (spec 6.4) are left out of every metric.
      if (args.length === 0) throw new Error('usage: team <pubkey>...')
      const wallets = args.map((a, i) => publicKeyArg(`pubkey ${i + 1}`, a).toBase58())
      return withDb(async (db) => {
        for (const w of wallets) await setWalletKind(db, w, 'team')
        await logOps(db, { actor: 'admin', action: 'team', detail: { wallets } })
        console.log(`team wallets: ${wallets.join(', ')}`)
      })
    }
    case 'flag': {
      // Tier 2 feature flags (spec 3.3); the API reads them on every request.
      const { name, on } = flagArgs(args)
      return withDb(async (db) => {
        await setFlag(db, name, on, 'ops')
        const flags = await readFlags(db)
        console.log(`${name} is now ${on ? 'on' : 'off'}`)
        for (const n of FLAG_NAMES) console.log(`  ${n.padEnd(20)} ${flags[n] ? 'on' : 'off'}`)
      })
    }
    case 'backfill-bot-memo': {
      // trades.bot_memo of the rows indexed before the column existed; safe to run again.
      const [rpc] = rpcEndpoints([need('HORAGON_RPC_URL')], env.RPC_WS_URLS)
      if (!rpc) throw new Error('HORAGON_RPC_URL is not set')
      const connection = makeConnection(rpc.url, rpc.wsUrl)
      await assertCluster(connection, cluster())
      return withDb(async (db) => {
        const result = await backfillBotMemo({
          db,
          getTransactions: (sigs) =>
            connection.getTransactions(sigs, {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed',
            }),
          log: (line) => console.log(line),
        })
        await logOps(db, { actor: 'admin', action: 'backfill-bot-memo', detail: { ...result } })
        console.log(
          `done: ${result.read} read, ${result.bots} with the bot memo, ${result.left} left`,
        )
      })
    }
    case 'watchdog': {
      // Exit 2 while the keeper heartbeat is stale during a game window (watchdog.ts).
      const alerts = alerter()
      return withDb(async (db) => {
        process.exitCode = await watchdogRun(db, alerts, Math.floor(Date.now() / 1000), log)
      })
    }
    case 'deploy-check': {
      // ops/deploy-keeper.sh runs it on the VPS before a deploy restarts the keeper (exit 2:
      // refused unless --force). The keeper's own window: KEEPER_TIMINGS over the defaults.
      const timings = timingsFrom(env.KEEPER_TIMINGS)
      return withDb(async (db) => {
        const now = Math.floor(Date.now() / 1000)
        const games = await listGames(db, {
          from: new Date((now - DEPLOY_CHECK_BACK_SECS) * 1000),
          to: new Date((now + timings.createLeadSecs + 1) * 1000),
        })
        const blockers = deployBlockers(games, now, timings)
        for (const line of deployCheckLines(blockers, now)) console.log(line)
        process.exitCode = blockers.length > 0 ? 2 : 0
      })
    }
    case 'help':
      console.log(USAGE)
      return
    case 'propose':
    case 'challenge':
    case 'halt': {
      const gameId = args[0]
      if (!gameId) throw new Error(`usage: ${command} <gameId>`)
      const proposal = command === 'propose' ? proposeArgs(gameId, values) : null
      const c = await setup(guardianKey, values.keypair)
      try {
        if (proposal) await propose(c, gameId, proposal)
        else if (command === 'challenge') await challenge(c, gameId)
        else await halt(c, gameId)
      } finally {
        await c.close()
      }
      return
    }
    case 'init-config':
    case 'pause':
    case 'resume':
    case 'fund-authority': {
      // Arguments are checked before anything connects.
      const init = command === 'init-config' ? initConfigArgs(values) : null
      const amount = args[0] ?? ''
      const lamports = command === 'fund-authority' ? solToLamports(amount) : 0
      const c = await setup(adminKey, values.keypair)
      try {
        if (init) await initConfig(c, init)
        else if (command === 'fund-authority') await fundAuthority(c, amount, lamports)
        else await setPaused(c, command === 'pause')
      } finally {
        await c.close()
      }
      return
    }
    default:
      throw new Error(command ? `unknown command "${command}"\n${USAGE}` : USAGE)
  }
}

run(process.argv.slice(2)).then(
  // Exit explicitly: an idle socket must not keep a oneshot unit (the watchdog) running.
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    const report = opsErrorReport(err)
    for (const line of report.lines) console.error(line)
    process.exit(report.exitCode)
  },
)
