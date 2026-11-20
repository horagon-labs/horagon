import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  type PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { PROTOCOL_DAO } from '../pm-amm/constants'
import { buildSwapIx, type SwapIxInput } from '../pm-amm/ix'
import { deriveNoMint, deriveYesMint } from '../pm-amm/pda'

/** Swaps peak near 510k CU (S1, S3a); 800k leaves headroom and stays under the sponsor's 1M cap. */
export const SWAP_COMPUTE_UNITS = 800_000
/** Largest serialized transaction Solana accepts. */
export const MAX_TX_BYTES = 1_232

export interface AtaSpec {
  owner: PublicKey
  mint: PublicKey
}

export const ataAddress = (a: AtaSpec) => getAssociatedTokenAddressSync(a.mint, a.owner, true)

/**
 * Every token account a swap touches: the user's mUSDC, YES and NO, and the two fee ATAs
 * (PROTOCOL_DAO and the market authority). Spec section 9 sponsors exactly these five.
 */
export function tradeAtas(
  p: Pick<SwapIxInput, 'user' | 'market' | 'collateralMint' | 'authority'>,
): AtaSpec[] {
  return [
    { owner: p.user, mint: p.collateralMint },
    { owner: p.user, mint: deriveYesMint(p.market) },
    { owner: p.user, mint: deriveNoMint(p.market) },
    { owner: PROTOCOL_DAO, mint: p.collateralMint },
    { owner: p.authority, mint: p.collateralMint },
  ]
}

export function createAtaIxs(
  feePayer: PublicKey,
  atas: readonly AtaSpec[],
): TransactionInstruction[] {
  return atas.map((a) =>
    createAssociatedTokenAccountIdempotentInstruction(feePayer, ataAddress(a), a.owner, a.mint),
  )
}

export interface BuildTradeTxInput {
  /** The sponsor (sponsored trades) or the user. */
  feePayer: PublicKey
  recentBlockhash: string
  swap: SwapIxInput
  /** The ATAs from `tradeAtas` that do not exist yet; `feePayer` pays their rent. */
  createAtas: readonly AtaSpec[]
  computeUnits?: number
  microLamportsPerCu?: number
}

/** Unsigned v0 swap transaction: compute budget, idempotent ATA creates, then the swap. */
export function buildTradeTransaction(input: BuildTradeTxInput): VersionedTransaction {
  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnits ?? SWAP_COMPUTE_UNITS }),
  ]
  if (input.microLamportsPerCu) {
    instructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: input.microLamportsPerCu }),
    )
  }
  instructions.push(...createAtaIxs(input.feePayer, input.createAtas), buildSwapIx(input.swap))
  const message = new TransactionMessage({
    payerKey: input.feePayer,
    recentBlockhash: input.recentBlockhash,
    instructions,
  }).compileToV0Message()
  return new VersionedTransaction(message)
}
