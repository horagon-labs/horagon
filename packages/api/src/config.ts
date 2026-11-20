// Environment -> ApiDeps. Read once per process; every variable is listed in .env.example.
import { connectPostgres, type Db } from '@horagon/db'
import { DEVNET_MUSDC_MINT, HoragonError, HoragonProgram } from '@horagon/sdk'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import pino from 'pino'
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

/** Spec 19.1: Horagon refuses mainnet everywhere. */
export function assertNotMainnet(rpcUrl: string): void {
  if (/mainnet/i.test(rpcUrl)) {
    throw new HoragonError('MAINNET_DISABLED', 'HORAGON_RPC_URL points at mainnet')
  }
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
  const sponsorKey = env.SPONSOR_SECRET_KEY
  return {
    db: db ?? connectPostgres(need('DATABASE_URL')).db,
    connection: new Connection(rpcUrl, 'confirmed'),
    cluster,
    program: new HoragonProgram({ collateralMint }),
    collateralMint,
    ...(sponsorKey
      ? {
          sponsor: {
            keypair: parseSecretKey(sponsorKey),
            dailyCapLamports: BigInt(Math.round(Number(env.SPONSOR_DAILY_CAP_SOL ?? '2') * 1e9)),
            txPerHour: Number(env.SPONSOR_TX_PER_HOUR ?? '30'),
            atasPerDay: {
              wallet: Number(env.SPONSOR_ATAS_PER_WALLET_DAY ?? '26'),
              ip: Number(env.SPONSOR_ATAS_PER_IP_DAY ?? '78'),
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
