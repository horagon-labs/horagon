import type { Db } from '@horagon/db'
import type { HoragonProgram } from '@horagon/sdk'
import type { Connection, Keypair, PublicKey } from '@solana/web3.js'
import type { Logger } from 'pino'

export interface FaucetResult {
  signature: string | null
  /** mUSDC, whole units (the pm-AMM faucet gives 1,000). */
  amount: number
}

/** Calls the pm-AMM faucet for one wallet. Throws ApiError(RATE_LIMITED) on its 429. */
export type FaucetClient = (wallet: string) => Promise<FaucetResult>

export interface SponsorConfig {
  keypair: Keypair
  /** Daily (UTC) cap on reserved lamports: fees plus ATA rent (spec 9). */
  dailyCapLamports: bigint
  /** Per wallet and per hashed IP (spec 9: 30 transactions an hour). */
  txPerHour: number
  /**
   * New token accounts the sponsor pays rent for, per day-sized bucket (default 26 a wallet: YES
   * and NO in 12 markets plus mUSDC; 78 an IP). Each costs 1,488,440 lamports on devnet (Tier 0,
   * S3a) that the user can keep by closing the account to themselves.
   */
  atasPerDay: { wallet: number; ip: number }
}

/** Everything a handler touches. Built once per process (Next.js instance, `horagon dev`). */
export interface ApiDeps {
  db: Db
  connection: Connection
  cluster: 'devnet' | 'localnet'
  program: HoragonProgram
  collateralMint: PublicKey
  /** Absent: `/tx/submit` answers SPONSOR_REJECTED and `/tx/trade` builds unsponsored. */
  sponsor?: SponsorConfig
  faucet: FaucetClient
  /** Public origin used in `evidence_uri` and links, e.g. https://horagon.com. */
  publicUrl: string
  /** Salt for hashing client IPs before they touch the DB or a log. */
  ipSalt: string
  version: string
  log: Logger
  /** Unix seconds; injected so tests can freeze time. */
  now(): number
}
