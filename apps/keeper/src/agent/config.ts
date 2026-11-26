// Configuration of the reference agent (agent-main.ts), from the same environment file as the
// keeper (`.env.keeper` on the VPS): the shared RPC, database, mint, Telegram and faucet
// variables, plus the AGENT_* ones. Every value is validated at start-up, a mainnet RPC is
// refused like the keeper refuses it, and errors never quote a value.
import { join } from 'node:path'
import { DEVNET_MUSDC_MINT } from '@horagon/sdk'
import { type Keypair, PublicKey } from '@solana/web3.js'
import { type ZodError, z } from 'zod'
import {
  type Cluster,
  loadKeypair,
  REPO_DIR,
  type RpcEndpoint,
  resolveKeyPath,
  rpcEndpoints,
  telegramSettings,
} from '../config'
import { DEFAULT_STALL_SECS, MIN_STALL_SECS } from '../stall'
import { WALLETS_FILE } from './listing'

/** The decision rules, in the units the agent computes in (seconds, probabilities, raw mUSDC). */
export interface AgentParams {
  intervalSecs: number
  /** Trade PRACTICE markets too (never on by default). */
  practice: boolean
  fanLagSecs: number
  /** The model probability counts only this long after the feed read that wrote it. */
  modelMaxAgeSecs: number
  /** No swap within this long of a market's end_ts. */
  endBufferSecs: number
  /** No swap while |model - price| is at most this. */
  band: number
  /** The target stops this short of the model. */
  stopShort: number
  /** The post-trade price lands within this of the target. */
  tolerance: number
  slippageBps: number
  /** Raw mUSDC (6 decimals). */
  maxPerSwap: bigint
  maxPerGame: bigint
  minSwap: bigint
  maxSwapsPerGame: number
  /** Consecutive failed reads or sends before a pause. */
  maxFailures: number
  pauseSecs: number
  /** Lamports. */
  minSolLamports: bigint
  /** Raw mUSDC. */
  minMusdc: bigint
}

export interface AgentConfig {
  /** Logs every decision and sends nothing: unless AGENT_DRY_RUN=0. */
  dryRun: boolean
  agent: Keypair
  /**
   * docs/metrics-wallets.json at the repo root AGENT_KEYPAIR resolves against: the agent starts
   * only when it lists the agent's wallet as team-burner (listing.ts).
   */
  walletsFile: string
  /** Primary first, then the backup. */
  rpcs: RpcEndpoint[]
  cluster: Cluster
  databaseUrl: string
  collateralMint: PublicKey
  telegram: { token: string; chatId: string } | null
  faucetUrl: string
  priorityMicroLamports: number
  stallSecs: number
  logLevel: string
  params: AgentParams
}

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const

/** An empty value counts as unset, so a blank line in the env file keeps the default. */
const blank = (v: unknown) => (v === '' ? undefined : v)
const flag = (def: '0' | '1') => z.preprocess(blank, z.enum(['0', '1']).default(def))
const int = (min: number, max: number, def: number) =>
  z.preprocess(blank, z.coerce.number().int().min(min).max(max).default(def))
const num = (min: number, max: number, def: number) =>
  z.preprocess(blank, z.coerce.number().min(min).max(max).default(def))
/** mUSDC, at most 6 decimals. */
const musdc = (def: number) =>
  z.preprocess(
    blank,
    z.coerce
      .number()
      .positive()
      .max(1_000_000)
      .refine((n) => Math.abs(n * 1e6 - Math.round(n * 1e6)) < 1e-6, 'at most 6 decimals')
      .default(def),
  )

/** Every AGENT_* variable but AGENT_ENABLED, with its default. */
const ParamsSchema = z.object({
  // Dry unless AGENT_DRY_RUN=0: trading takes a line of its own, AGENT_ENABLED=1 alone never.
  AGENT_DRY_RUN: flag('1'),
  AGENT_PRACTICE: flag('0'),
  AGENT_KEYPAIR: z.preprocess(blank, z.string().min(1).default('.keys/agent.json')),
  AGENT_INTERVAL_SECS: int(5, 60, 20),
  AGENT_FAN_LAG_SECS: int(0, 3_600, 90),
  AGENT_MODEL_MAX_AGE_SECS: int(5, 600, 60),
  AGENT_END_BUFFER_SECS: int(60, 3_600, 120),
  AGENT_BAND: num(0.001, 0.5, 0.04),
  AGENT_STOP_SHORT: num(0, 0.5, 0.02),
  AGENT_TOLERANCE: num(0.0001, 0.1, 0.005),
  AGENT_SLIPPAGE_BPS: int(1, 1_000, 200),
  AGENT_MAX_PER_SWAP: musdc(100),
  AGENT_MAX_PER_GAME: musdc(2_000),
  AGENT_MAX_SWAPS_PER_GAME: int(1, 1_000, 40),
  AGENT_MIN_SWAP: musdc(1),
  AGENT_MAX_FAILURES: int(1, 100, 5),
  AGENT_PAUSE_SECS: int(60, 86_400, 600),
  AGENT_MIN_SOL: num(0, 100, 0.1),
  AGENT_MIN_MUSDC: num(0, 1_000_000, 200),
})

/** Shared with the keeper, same rules as apps/keeper/src/config.ts. */
const SharedSchema = z.object({
  HORAGON_RPC_URL: z.url({ protocol: /^https?$/ }),
  HORAGON_RPC_BACKUP_URL: z.url({ protocol: /^https?$/ }).optional(),
  RPC_WS_URLS: z.string().optional(),
  HORAGON_CLUSTER: z.enum(['devnet', 'localnet']).default('devnet'),
  DATABASE_URL: z.string().min(1),
  HORAGON_COLLATERAL_MINT: z.string().default(DEVNET_MUSDC_MINT.toBase58()),
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_CHAT_ID: z.string().min(1).optional(),
  HORAGON_FAUCET_URL: z
    .url({ protocol: /^https$/ })
    .default('https://pm-amm-devnet.vercel.app/api/faucet'),
  PRIORITY_MICROLAMPORTS: z.coerce.number().int().min(0).default(10_000),
  /** Public key only: the agent refuses to run as the sponsor. */
  SPONSOR_PUBKEY: z.string().optional(),
  KEEPER_STALL_SECS: z.coerce.number().int().min(MIN_STALL_SECS).default(DEFAULT_STALL_SECS),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
})

const EnvSchema = ParamsSchema.extend(SharedSchema.shape)

/** The kill switch: the agent runs only with AGENT_ENABLED=1, whatever else is set. */
export function agentEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.AGENT_ENABLED === '1'
}

/** LOG_LEVEL when it is valid, else info: for the lines written before the config is read. */
export function agentLogLevel(env: NodeJS.ProcessEnv): string {
  const level = env.LOG_LEVEL
  return level && (LOG_LEVELS as readonly string[]).includes(level) ? level : 'info'
}

/** Issue paths and messages only: zod never puts the input value in its messages by default. */
const issues = (err: ZodError) =>
  err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')

const raw = (musdcAmount: number) => BigInt(Math.round(musdcAmount * 1e6))

function paramsOf(e: z.output<typeof ParamsSchema>): AgentParams {
  return {
    intervalSecs: e.AGENT_INTERVAL_SECS,
    practice: e.AGENT_PRACTICE === '1',
    fanLagSecs: e.AGENT_FAN_LAG_SECS,
    modelMaxAgeSecs: e.AGENT_MODEL_MAX_AGE_SECS,
    endBufferSecs: e.AGENT_END_BUFFER_SECS,
    band: e.AGENT_BAND,
    stopShort: e.AGENT_STOP_SHORT,
    tolerance: e.AGENT_TOLERANCE,
    slippageBps: e.AGENT_SLIPPAGE_BPS,
    maxPerSwap: raw(e.AGENT_MAX_PER_SWAP),
    maxPerGame: raw(e.AGENT_MAX_PER_GAME),
    minSwap: raw(e.AGENT_MIN_SWAP),
    maxSwapsPerGame: e.AGENT_MAX_SWAPS_PER_GAME,
    maxFailures: e.AGENT_MAX_FAILURES,
    pauseSecs: e.AGENT_PAUSE_SECS,
    minSolLamports: BigInt(Math.round(e.AGENT_MIN_SOL * 1e9)),
    minMusdc: raw(e.AGENT_MIN_MUSDC),
  }
}

/** The parameters with every AGENT_* variable unset. */
export function defaultAgentParams(): AgentParams {
  return paramsOf(ParamsSchema.parse({}))
}

function publicKey(name: string, value: string): PublicKey {
  try {
    return new PublicKey(value)
  } catch {
    throw new Error(`${name} is not a public key`)
  }
}

export function loadAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { repoDir?: string } = {},
): AgentConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) throw new Error(`invalid agent environment: ${issues(parsed.error)}`)
  const e = parsed.data
  // The target lies strictly between the price and the model, and its landing window never
  // reaches back to the price: a swap that is due always moves the price.
  if (!(e.AGENT_STOP_SHORT + e.AGENT_TOLERANCE < e.AGENT_BAND)) {
    throw new Error('AGENT_STOP_SHORT + AGENT_TOLERANCE must be under AGENT_BAND')
  }
  if (e.AGENT_MIN_SWAP > e.AGENT_MAX_PER_SWAP) {
    throw new Error('AGENT_MIN_SWAP must not exceed AGENT_MAX_PER_SWAP')
  }
  if (e.AGENT_MAX_PER_SWAP > e.AGENT_MAX_PER_GAME) {
    throw new Error('AGENT_MAX_PER_SWAP must not exceed AGENT_MAX_PER_GAME')
  }
  // The stall guard exits a process silent for KEEPER_STALL_SECS; each round is activity.
  if (e.AGENT_INTERVAL_SECS * 2 > e.KEEPER_STALL_SECS) {
    throw new Error('AGENT_INTERVAL_SECS must be at most half of KEEPER_STALL_SECS')
  }
  const rpcs = rpcEndpoints(
    [e.HORAGON_RPC_URL, ...(e.HORAGON_RPC_BACKUP_URL ? [e.HORAGON_RPC_BACKUP_URL] : [])],
    e.RPC_WS_URLS,
  )
  const telegram = telegramSettings(e)
  const repoDir = opts.repoDir ?? REPO_DIR
  const agent = loadKeypair(resolveKeyPath(e.AGENT_KEYPAIR, repoDir))
  if (e.SPONSOR_PUBKEY && agent.publicKey.equals(publicKey('SPONSOR_PUBKEY', e.SPONSOR_PUBKEY))) {
    throw new Error('AGENT_KEYPAIR is the sponsor: the agent needs a wallet of its own')
  }
  return {
    dryRun: e.AGENT_DRY_RUN === '1',
    agent,
    walletsFile: join(repoDir, WALLETS_FILE),
    rpcs,
    cluster: e.HORAGON_CLUSTER,
    databaseUrl: e.DATABASE_URL,
    collateralMint: publicKey('HORAGON_COLLATERAL_MINT', e.HORAGON_COLLATERAL_MINT),
    telegram,
    faucetUrl: e.HORAGON_FAUCET_URL,
    priorityMicroLamports: e.PRIORITY_MICROLAMPORTS,
    stallSecs: e.KEEPER_STALL_SECS,
    logLevel: e.LOG_LEVEL,
    params: paramsOf(e),
  }
}
