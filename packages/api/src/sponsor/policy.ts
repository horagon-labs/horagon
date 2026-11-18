import type { PublicKey } from '@solana/web3.js'

export interface SponsorLimits {
  /** Highest SetComputeUnitLimit the sponsor pays for (spec section 9: 1,000,000). */
  maxComputeUnits: number
  /** Highest SetComputeUnitPrice, in micro-lamports per CU. */
  maxMicroLamportsPerCu: bigint
  /** Most top-level instructions in one sponsored transaction. */
  maxInstructions: number
}

export const DEFAULT_SPONSOR_LIMITS: SponsorLimits = {
  maxComputeUnits: 1_000_000,
  maxMicroLamportsPerCu: 100_000n,
  maxInstructions: 12,
}

/** Everything the validator needs to know about the world. Pure data, no I/O. */
export interface SponsorPolicy {
  /** Pays the fee and ATA rent; holds only SOL. */
  sponsor: PublicKey
  /** mUSDC on devnet. */
  collateralMint: PublicKey
  /** Owners of the fee-receiving collateral ATAs a swap needs: PROTOCOL_DAO and the market authority. */
  feeOwners: readonly PublicKey[]
  /** True when the market is listed in Horagon's `markets` table. */
  isHoragonMarket(market: PublicKey): boolean
  /** True for the YES or NO mint of a Horagon market. */
  isOutcomeMint(mint: PublicKey): boolean
  limits: SponsorLimits
}

export type SponsorRejection =
  | 'LOOKUP_TABLES'
  | 'NOT_FEE_PAYER'
  | 'BAD_SIGNERS'
  | 'TOO_MANY_INSTRUCTIONS'
  | 'PROGRAM_NOT_ALLOWED'
  | 'COMPUTE_BUDGET'
  | 'ATA_RULE'
  | 'PM_AMM_RULE'
  | 'TOKEN_RULE'
  | 'SPONSOR_MISUSE'
  | 'NO_TRADE'

export type SponsorVerdict =
  | { ok: true; user: PublicKey }
  | { ok: false; reason: SponsorRejection; detail: string }
