// Environment -> ApiDeps. Read once per process; every variable is listed in .env.example.
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { connectPostgres, type Db } from '@horagon/db'
import { DEVNET_MUSDC_MINT, HoragonError, HoragonProgram } from '@horagon/sdk'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import pino from 'pino'
import { z } from 'zod'
import type { ApiDeps } from './deps'
import { pmAmmFaucet } from './faucet'

/** Base58 or a JSON byte array. A parse error never carries the value: JSON.parse quotes it. */
export function parseSecretKey(value: string): Keypair {
  try {
    const text = value.trim()
    const bytes = text.startsWith('[')
      ? Uint8Array.from(JSON.parse(text) as number[])
      : bs58.decode(text)
    return Keypair.fromSecretKey(bytes)
  } catch {
    throw new Error('Not a valid secret key: expected base58 or a JSON array of 64 bytes')
  }
}

/**
 * A Solana CLI keypair file: a JSON array of 64 bytes (same contract as the keeper's
 * `loadKeypair`). Errors name the variable and the path, never the content (JSON.parse quotes
 * the input it fails on). The path must be absolute: the web server runs with its working
 * directory in `apps/web`, so a relative path would be read from the wrong place.
 */
export function loadKeypairFile(name: string, path: string): Keypair {
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`${name}: cannot read the keypair file at ${path}`)
  }
  try {
    const bytes = z.array(z.number().int().min(0).max(255)).length(64).parse(JSON.parse(text))
    return Keypair.fromSecretKey(Uint8Array.from(bytes))
  } catch {
    throw new Error(`${name}: ${path} is not a Solana keypair file (a JSON array of 64 bytes)`)
  }
}

/**
 * Spec 19.1: Horagon refuses mainnet everywhere. This is the cheap check on the URL; the RPC's
 * genesis hash is checked before the sponsor signs anything (`sponsor/submit.ts`).
 */
export function assertNotMainnet(rpcUrl: string): void {
  if (/mainnet/i.test(rpcUrl)) {
    throw new HoragonError('MAINNET_DISABLED', 'HORAGON_RPC_URL points at mainnet')
  }
}

/**
 * A whole number from the environment, or `fallback` when unset. A bad value throws a fixed
 * message that names the variable and never quotes the value.
 */
function wholeNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: 0 | 1,
): number {
  const raw = env[name]
  const n = raw === undefined || raw.trim() === '' ? fallback : Number(raw)
  if (!Number.isSafeInteger(n) || n < min) {
    throw new Error(`${name} must be a whole number of ${min} or more`)
  }
  return n
}

/** SOL from the environment as lamports, above 0. */
function solAmount(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): bigint {
  const raw = env[name]
  const sol = raw === undefined || raw.trim() === '' ? fallback : Number(raw)
  const lamports = Math.round(sol * 1e9)
  if (!Number.isFinite(sol) || !Number.isSafeInteger(lamports) || lamports < 1) {
    throw new Error(`${name} must be an amount of SOL above 0`)
  }
  return BigInt(lamports)
}

export function depsFromEnv(env: Record<string, string | undefined>, db?: Db): ApiDeps {
  const need = (k: string) => {
    const v = env[k]
    if (!v) throw new Error(`${k} is not set`)
    return v
  }
  const rpcUrl = need('HORAGON_RPC_URL')
  assertNotMainnet(rpcUrl)
  const cluster = (env.HORAGON_CLUSTER ?? 'devnet') as 'devnet' | 'localnet'
  if (cluster !== 'devnet' && cluster !== 'localnet') {
    throw new HoragonError('MAINNET_DISABLED', `cluster must be devnet or localnet, got ${cluster}`)
  }
  const collateralMint = new PublicKey(env.HORAGON_COLLATERAL_MINT ?? DEVNET_MUSDC_MINT.toBase58())
  // SPONSOR_SECRET_KEY (how Vercel sets it) wins; SPONSOR_KEYPAIR (a file path) is for local
  // runs and is not read at all when the secret is set.
  const sponsorKey = env.SPONSOR_SECRET_KEY
  const sponsorKeypair = sponsorKey
    ? parseSecretKey(sponsorKey)
    : env.SPONSOR_KEYPAIR
      ? loadKeypairFile('SPONSOR_KEYPAIR', env.SPONSOR_KEYPAIR)
      : undefined
  return {
    db: db ?? connectPostgres(need('DATABASE_URL')).db,
    connection: new Connection(rpcUrl, 'confirmed'),
    cluster,
    program: new HoragonProgram({ collateralMint }),
    collateralMint,
    ...(sponsorKeypair
      ? {
          sponsor: {
            keypair: sponsorKeypair,
            dailyCapLamports: solAmount(env, 'SPONSOR_DAILY_CAP_SOL', 2),
            txPerHour: wholeNumber(env, 'SPONSOR_TX_PER_HOUR', 30, 1),
            // 0 is allowed: the sponsor then opens no new token accounts (RATE_LIMITED).
            atasPerDay: {
              wallet: wholeNumber(env, 'SPONSOR_ATAS_PER_WALLET_DAY', 26, 0),
              ip: wholeNumber(env, 'SPONSOR_ATAS_PER_IP_DAY', 78, 0),
            },
          },
        }
      : {}),
    faucet: pmAmmFaucet(env.HORAGON_FAUCET_URL),
    publicUrl: (env.HORAGON_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    ipSalt: need('IP_HASH_SALT'),
    version: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? env.HORAGON_VERSION ?? 'dev',
    log: pino({ level: env.LOG_LEVEL ?? 'info', base: { service: 'api' } }),
    now: () => Math.floor(Date.now() / 1000),
  }
}
