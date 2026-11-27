// Keeper configuration from the environment (systemd EnvironmentFile on the VPS). Every value
// is validated at start-up; a mainnet RPC is refused (spec 2: devnet play money only), first by
// its URL and then, before any other RPC or DB work, by its genesis hash.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  assertNotMainnetGenesis,
  DEVNET_MUSDC_MINT,
  errorSummary,
  HoragonError,
  isHoragonError,
} from '@horagon/sdk'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import pino, { type DestinationStream, type LogFn, type Logger } from 'pino'
import { type ZodError, z } from 'zod'
import {
  type AutoProposeMode,
  DEFAULT_SEEDS,
  DEFAULT_TIMINGS,
  type SeedPolicy,
  type Timings,
} from './planner'
import { evidenceUri, publicBaseUrl } from './propose'
import { DEFAULT_STALL_SECS, MIN_STALL_SECS } from './stall'

export { MAINNET_GENESIS_HASH } from '@horagon/sdk'

/** apps/keeper, whatever the working directory. */
const APP_DIR = join(import.meta.dirname, '..')
/** The repo root: relative paths (`.keys/…`) resolve here, not against the cwd. */
export const REPO_DIR = join(APP_DIR, '../..')

export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

export type Cluster = 'devnet' | 'localnet'

const TimingsSchema = z
  .strictObject({
    createLeadSecs: z.number().int().min(0),
    endOffsetSecs: z.number().int().min(300),
    createGraceSecs: z.number().int().min(0),
    finalStableSecs: z.number().int().min(0),
    feedSilentAlertSecs: z.number().int().min(10),
    feedSilentSecs: z.number().int().min(10),
    feedSilentWatchSecs: z.number().int().min(0),
    notStartedSecs: z.number().int().min(60),
    postponedResolveSecs: z.number().int().min(60),
    missingSourceSecs: z.number().int().min(60),
    secondSourceWaitSecs: z.number().int().min(0),
  })
  .partial()

/** An empty value counts as unset, so a blank line in the env file keeps the default. */
const blank = (v: unknown) => (v === '' ? undefined : v)

const EnvSchema = z.object({
  HORAGON_RPC_URL: z.url({ protocol: /^https?$/ }),
  HORAGON_RPC_BACKUP_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** Comma list of wss:// URLs, by position to the RPC URLs; an empty entry is derived. */
  RPC_WS_URLS: z.string().optional(),
  /** The indexer's and ATA watch's own RPC (reads only); unset uses HORAGON_RPC_URL. */
  HORAGON_INDEX_RPC_URL: z.preprocess(blank, z.url({ protocol: /^https$/ }).optional()),
  HORAGON_CLUSTER: z.enum(['devnet', 'localnet']).default('devnet'),
  DATABASE_URL: z.string().min(1),
  ATTESTOR_KEYPAIR: z.string().min(1).default('.keys/attestor.json'),
  HORAGON_COLLATERAL_MINT: z.string().default(DEVNET_MUSDC_MINT.toBase58()),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),
  KEEPER_FEED: z.enum(['espn', 'replay']).default('espn'),
  REPLAY_DIR: z.string().default('tests/fixtures/replay'),
  /** Same rule as `replayFeed`: 1-6 letters or digits, starting with a letter. */
  REPLAY_TAG: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]{0,5}$/)
    .optional(),
  REPLAY_TIPOFF: z.iso.datetime().optional(),
  REPLAY_SPEED: z.coerce.number().min(1).max(60).default(1),
  ESPN_ARCHIVE_DIR: z.string().default('apps/keeper/data/archive'),
  ELO_FILE: z.string().default('apps/keeper/data/elo.json'),
  /** JSON object overriding some of DEFAULT_TIMINGS, e.g. for a short Surfpool run. */
  KEEPER_TIMINGS: z.string().optional(),
  PRIORITY_MICROLAMPORTS: z.coerce.number().int().min(0).default(10_000),
  HALT_PRIORITY_MICROLAMPORTS: z.coerce.number().int().min(0).default(200_000),
  SEED_FEATURED_USDC: z.coerce.number().int().positive().optional(),
  SEED_REGULAR_USDC: z.coerce.number().int().positive().optional(),
  HORAGON_FAUCET_URL: z
    .url({ protocol: /^https$/ })
    .default('https://pm-amm-devnet.vercel.app/api/faucet'),
  /** The API's sponsor (public key only): turns on recording and watching the ATAs it pays for. */
  SPONSOR_PUBKEY: z.string().optional(),
  /** Seconds without any activity before the keeper exits so systemd restarts it. */
  KEEPER_STALL_SECS: z.coerce.number().int().min(MIN_STALL_SECS).default(DEFAULT_STALL_SECS),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  /** The API's public base URL: the evidence link of an auto-proposal (R6). */
  HORAGON_PUBLIC_URL: z.preprocess(blank, z.string().optional()),
  /** Auto-propose (R6): on, dry (pages "would propose", sends nothing) or off. */
  KEEPER_AUTO_PROPOSE: z.preprocess(blank, z.enum(['on', 'dry', 'off']).default('on')),
  /** balldontlie, the second source (free tier). Sent in a header only, never logged. */
  BALLDONTLIE_API_KEY: z.preprocess(blank, z.string().min(8).optional()),
})

/** Auto-propose as the keeper runs it: the mode asked for, unless something turns it off. */
export interface AutoProposeConfig {
  mode: AutoProposeMode
  /** HORAGON_PUBLIC_URL, checked (https, no trailing slash); null with the mode off. */
  publicUrl: string | null
  /** Why the mode is off (KEEPER_AUTO_PROPOSE=off, or no usable URL); null when on or dry. */
  off: string | null
}

/** The longest game id `GameIdSchema` allows: a URL that fits it fits every game. */
const LONGEST_GAME_ID = `abcdefgh-${'0'.repeat(16)}`

/**
 * KEEPER_AUTO_PROPOSE (default on) with HORAGON_PUBLIC_URL. Without a usable URL the mode is off,
 * with the reason: the keeper still starts, and `main.ts` alerts `auto-propose-off`.
 */
export function autoProposeFrom(
  e: { KEEPER_AUTO_PROPOSE: AutoProposeMode; HORAGON_PUBLIC_URL?: string | undefined },
  cluster: Cluster,
): AutoProposeConfig {
  if (e.KEEPER_AUTO_PROPOSE === 'off')
    return { mode: 'off', publicUrl: null, off: 'KEEPER_AUTO_PROPOSE=off' }
  if (!e.HORAGON_PUBLIC_URL)
    return { mode: 'off', publicUrl: null, off: 'HORAGON_PUBLIC_URL is not set' }
  try {
    const publicUrl = publicBaseUrl(e.HORAGON_PUBLIC_URL, cluster)
    evidenceUri(publicUrl, cluster, LONGEST_GAME_ID)
    return { mode: e.KEEPER_AUTO_PROPOSE, publicUrl, off: null }
  } catch (err) {
    return { mode: 'off', publicUrl: null, off: (err as Error).message }
  }
}

export interface RpcEndpoint {
  url: string
  /** Explicit websocket endpoint; when absent web3.js derives it from `url`. */
  wsUrl?: string
}

export interface KeeperConfig {
  /** Primary first, then the backup. */
  rpcs: RpcEndpoint[]
  /** HORAGON_INDEX_RPC_URL, or null: index reads use the main connection. Log its host only. */
  indexRpcUrl: string | null
  cluster: Cluster
  databaseUrl: string
  attestor: Keypair
  collateralMint: PublicKey
  telegram: { token: string; chatId: string } | null
  feed:
    | { kind: 'espn'; archiveDir: string }
    | { kind: 'replay'; dir: string; tag: string; tipoff: Date; speed: number }
  eloFile: string
  timings: Timings
  seeds: SeedPolicy
  priority: { normal: number; halt: number }
  faucetUrl: string
  sponsor: PublicKey | null
  stallSecs: number
  logLevel: string
  autoPropose: AutoProposeConfig
  /** BALLDONTLIE_API_KEY, or null: no second source. Never log it. */
  balldontlieKey: string | null
}

/** A path from the environment or the command line: relative ones resolve from the repo root. */
export function resolveKeyPath(path: string, repoDir = REPO_DIR): string {
  return resolve(repoDir, path)
}

/**
 * A Solana CLI keypair file: a JSON array of 64 bytes. Errors name the file, never its content
 * (JSON.parse quotes the input it fails on).
 */
export function loadKeypair(path: string): Keypair {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`${path}: cannot read the keypair file (${errorSummary(err).code ?? 'error'})`)
  }
  try {
    const bytes = z.array(z.number().int().min(0).max(255)).length(64).parse(JSON.parse(text))
    return Keypair.fromSecretKey(Uint8Array.from(bytes))
  } catch {
    throw new Error(`${path}: not a Solana keypair file (a JSON array of 64 bytes)`)
  }
}

/** Cheap first check on the URL (host and path); `assertCluster` checks the genesis hash. */
export function assertNotMainnet(url: string): void {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    // The URL may carry an API key: never quote it.
    throw new Error('not a valid RPC URL')
  }
  if (/mainnet/i.test(`${u.hostname}${u.pathname}`)) {
    throw new HoragonError(
      'MAINNET_DISABLED',
      'refusing a mainnet RPC URL: Horagon runs on devnet only',
    )
  }
}

/** The RPC answers, but for another cluster than the one configured. */
export class ClusterMismatch extends Error {
  override name = 'ClusterMismatch'
}

/** A definitive refusal (mainnet, wrong cluster), as opposed to an RPC that did not answer. */
export const isClusterRefusal = (err: unknown) =>
  err instanceof ClusterMismatch || (isHoragonError(err) && err.code === 'MAINNET_DISABLED')

/**
 * The RPC really is the cluster configured: never mainnet (the SDK's genesis check), and devnet
 * by its genesis hash. One getGenesisHash call; an RPC failure is rethrown as it is.
 */
export async function assertCluster(
  connection: Pick<Connection, 'getGenesisHash'>,
  cluster: Cluster,
): Promise<void> {
  let genesis: string | undefined
  await assertNotMainnetGenesis({
    getGenesisHash: async () => {
      genesis = await connection.getGenesisHash()
      return genesis
    },
  })
  if (cluster === 'devnet' && genesis !== DEVNET_GENESIS_HASH) {
    throw new ClusterMismatch(`HORAGON_CLUSTER=devnet but the RPC's genesis hash is ${genesis}`)
  }
}

/** Cluster checks a backup RPC gets at start-up before the keeper starts without it. */
export const BACKUP_RPC_TRIES = 3

/**
 * `assertCluster` on every connection, in order, before the keeper does anything else; returns
 * the connections that passed, the primary first. Fails closed: a refusal on any of them throws
 * at once. The primary is asked again with backoff until it answers (nothing else runs
 * meanwhile) rather than exiting into a systemd restart loop. A backup that has not answered
 * after `backupTries` is left out, with a warning and `onBackupDown`: a connection is never
 * used unverified.
 */
export async function verifyCluster<C extends Pick<Connection, 'getGenesisHash'>>(
  connections: readonly C[],
  cluster: Cluster,
  opts: {
    log: Logger
    sleep?: (ms: number) => Promise<void>
    maxDelayMs?: number
    backupTries?: number
    onBackupDown?: (rpc: number, error: string) => Promise<void>
  },
): Promise<C[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const maxDelay = opts.maxDelayMs ?? 60_000
  const verified: C[] = []
  for (const [rpc, connection] of connections.entries()) {
    const tries = rpc === 0 ? Number.POSITIVE_INFINITY : (opts.backupTries ?? BACKUP_RPC_TRIES)
    for (let attempt = 0; ; attempt++) {
      try {
        await assertCluster(connection, cluster)
        verified.push(connection)
        break
      } catch (err) {
        if (isClusterRefusal(err)) throw err
        const error = errorSummary(err).message
        if (attempt + 1 >= tries) {
          opts.log.warn({ rpc, error, tries }, 'backup RPC not verified; starting without it')
          await opts.onBackupDown?.(rpc, error)
          break
        }
        const delayMs = Math.min(maxDelay, 5_000 * 2 ** attempt)
        opts.log.warn({ rpc, error, delayMs }, 'RPC cluster not verified yet; asking again')
        await sleep(delayMs)
      }
    }
  }
  return verified
}

/**
 * The Telegram alert settings, both or neither: a half-set pair is refused, not read as "no
 * alerts". An empty value counts as unset; the error never carries a value.
 */
export function telegramSettings(env: {
  TELEGRAM_BOT_TOKEN?: string | undefined
  TELEGRAM_CHAT_ID?: string | undefined
}): { token: string; chatId: string } | null {
  const token = env.TELEGRAM_BOT_TOKEN || undefined
  const chatId = env.TELEGRAM_CHAT_ID || undefined
  if (Boolean(token) !== Boolean(chatId)) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together')
  }
  return token && chatId ? { token, chatId } : null
}

/** The RPC URLs with their websocket URLs (`RPC_WS_URLS`, by position), all checked. */
export function rpcEndpoints(urls: readonly string[], wsList?: string): RpcEndpoint[] {
  const ws = wsList?.trim() ? wsList.split(',').map((s) => s.trim()) : []
  if (ws.length > urls.length) {
    throw new Error(`RPC_WS_URLS has ${ws.length} entries for ${urls.length} RPC URLs`)
  }
  return urls.map((url, i) => {
    assertNotMainnet(url)
    const wsUrl = ws[i]
    if (!wsUrl) return { url }
    let parsed: URL | null = null
    try {
      parsed = new URL(wsUrl)
    } catch {}
    if (parsed?.protocol !== 'wss:') {
      throw new Error(`RPC_WS_URLS entry ${i + 1} must be a wss:// URL`)
    }
    assertNotMainnet(wsUrl)
    return { url, wsUrl }
  })
}

/** Every RPC call gets this long, combined with any signal the caller passes. */
export const RPC_TIMEOUT_MS = 15_000

/** `onActivity` runs when a call completes, answered or failed (the stall guard's clock). */
export function timeoutFetch(
  ms: number,
  base: typeof fetch = fetch,
  onActivity?: () => void,
): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(ms)
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    const call = base(input, { ...init, signal })
    return onActivity ? call.finally(onActivity) : call
  }
}

/**
 * The one way the keeper and ops open a Connection: confirmed, no web3.js retries on a 429
 * (TxSender switches RPC instead), and a timeout on every RPC call, which bounds the wall-clock
 * time of the executor's 90 s wait. `opts` is for tests.
 */
export function makeConnection(
  url: string,
  wsUrl?: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; onActivity?: () => void } = {},
): Connection {
  return new Connection(url, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: timeoutFetch(opts.timeoutMs ?? RPC_TIMEOUT_MS, opts.fetchImpl, opts.onActivity),
    ...(wsUrl ? { wsEndpoint: wsUrl } : {}),
  })
}

/** The host of an RPC URL, the only part of it that is ever logged (the rest may hold a key). */
export function rpcHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return '(invalid URL)'
  }
}

/**
 * The Connection the indexer and the ATA watch read through. Without HORAGON_INDEX_RPC_URL it is
 * the main one (`fallback`, read on every call, so it follows TxSender's switch to the backup).
 * With it, a Connection of its own, cluster-checked like a backup: a refusal throws (fail
 * closed); one that has not answered after BACKUP_RPC_TRIES is left out for the main one, with a
 * warning and `onDown`. Logs name its host only.
 */
export async function indexReadConnection<C extends Pick<Connection, 'getGenesisHash'>>(opts: {
  url: string | null
  fallback: () => C
  cluster: Cluster
  log: Logger
  make: (url: string) => C
  sleep?: (ms: number) => Promise<void>
  onDown?: (error: string) => Promise<void>
}): Promise<() => C> {
  if (!opts.url) return opts.fallback
  const indexRpcHost = rpcHost(opts.url)
  const own = opts.make(opts.url)
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let attempt = 0; ; attempt++) {
    try {
      await assertCluster(own, opts.cluster)
      opts.log.info({ indexRpcHost }, 'index reads use their own RPC')
      return () => own
    } catch (err) {
      if (isClusterRefusal(err)) throw err
      const error = errorSummary(err).message
      if (attempt + 1 >= BACKUP_RPC_TRIES) {
        opts.log.warn(
          { indexRpcHost, error, tries: BACKUP_RPC_TRIES },
          'index RPC not verified; index reads use the main RPC',
        )
        await opts.onDown?.(error)
        return opts.fallback
      }
      await sleep(5_000 * 2 ** attempt)
    }
  }
}

/** Issue paths and messages only: zod never puts the input value in its messages by default. */
const issues = (err: ZodError) =>
  err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')

function publicKey(name: string, value: string): PublicKey {
  try {
    return new PublicKey(value)
  } catch {
    throw new Error(`${name} is not a public key`)
  }
}

/** DEFAULT_TIMINGS with KEEPER_TIMINGS (a JSON object) over it; also read by `deploy-check`. */
export function timingsFrom(raw: string | undefined): Timings {
  if (!raw) return { ...DEFAULT_TIMINGS }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error('KEEPER_TIMINGS must be a JSON object')
  }
  const parsed = TimingsSchema.safeParse(json)
  if (!parsed.success) throw new Error(`KEEPER_TIMINGS: ${issues(parsed.error)}`)
  return { ...DEFAULT_TIMINGS, ...parsed.data }
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { repoDir?: string } = {},
): KeeperConfig {
  const repoDir = opts.repoDir ?? REPO_DIR
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) throw new Error(`invalid keeper environment: ${issues(parsed.error)}`)
  const e = parsed.data
  const rpcs = rpcEndpoints(
    [e.HORAGON_RPC_URL, ...(e.HORAGON_RPC_BACKUP_URL ? [e.HORAGON_RPC_BACKUP_URL] : [])],
    e.RPC_WS_URLS,
  )
  if (e.HORAGON_INDEX_RPC_URL) assertNotMainnet(e.HORAGON_INDEX_RPC_URL)
  if (e.KEEPER_FEED === 'replay' && (!e.REPLAY_TAG || !e.REPLAY_TIPOFF)) {
    throw new Error('KEEPER_FEED=replay needs REPLAY_TAG and REPLAY_TIPOFF')
  }
  const telegram = telegramSettings(e)
  const usdc = (n: number | undefined, fallback: bigint) =>
    n === undefined ? fallback : BigInt(n) * 1_000_000n
  const path = (p: string) => resolve(repoDir, p)
  return {
    rpcs,
    indexRpcUrl: e.HORAGON_INDEX_RPC_URL ?? null,
    cluster: e.HORAGON_CLUSTER,
    databaseUrl: e.DATABASE_URL,
    attestor: loadKeypair(resolveKeyPath(e.ATTESTOR_KEYPAIR, repoDir)),
    collateralMint: publicKey('HORAGON_COLLATERAL_MINT', e.HORAGON_COLLATERAL_MINT),
    telegram,
    feed:
      e.KEEPER_FEED === 'replay'
        ? {
            kind: 'replay',
            dir: path(e.REPLAY_DIR),
            tag: e.REPLAY_TAG as string,
            tipoff: new Date(e.REPLAY_TIPOFF as string),
            speed: e.REPLAY_SPEED,
          }
        : { kind: 'espn', archiveDir: path(e.ESPN_ARCHIVE_DIR) },
    eloFile: path(e.ELO_FILE),
    timings: timingsFrom(e.KEEPER_TIMINGS),
    seeds: {
      featured: usdc(e.SEED_FEATURED_USDC, DEFAULT_SEEDS.featured),
      regular: usdc(e.SEED_REGULAR_USDC, DEFAULT_SEEDS.regular),
    },
    priority: { normal: e.PRIORITY_MICROLAMPORTS, halt: e.HALT_PRIORITY_MICROLAMPORTS },
    faucetUrl: e.HORAGON_FAUCET_URL,
    sponsor: e.SPONSOR_PUBKEY ? publicKey('SPONSOR_PUBKEY', e.SPONSOR_PUBKEY) : null,
    stallSecs: e.KEEPER_STALL_SECS,
    logLevel: e.LOG_LEVEL,
    autoPropose: autoProposeFrom(e, e.HORAGON_CLUSTER),
    balldontlieKey: e.BALLDONTLIE_API_KEY ?? null,
  }
}

/**
 * JSON logs for journald; `destination` is for tests. `onActivity` runs on every log call that
 * is emitted (the stall guard's clock); the output itself is unchanged.
 */
export function createLogger(
  level: string,
  service = 'keeper',
  destination?: DestinationStream,
  onActivity?: () => void,
): Logger {
  const options = {
    level,
    base: { service },
    redact: { paths: ['token', '*.token', 'secretKey', '*.secretKey'], censor: '[redacted]' },
    ...(onActivity
      ? {
          hooks: {
            logMethod(this: Logger, args: Parameters<LogFn>, method: LogFn) {
              onActivity()
              method.apply(this, args)
            },
          },
        }
      : {}),
  }
  return destination ? pino(options, destination) : pino(options)
}
