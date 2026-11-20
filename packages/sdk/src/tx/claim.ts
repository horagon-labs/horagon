import { createCloseAccountInstruction } from '@solana/spl-token'
import {
  type PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { HoragonError } from '../errors'
import { buildClaimWinningsIx } from '../pm-amm/ix'
import { deriveNoMint, deriveYesMint } from '../pm-amm/pda'
import { type AtaSpec, ataAddress, createAtaIxs, MAX_TX_BYTES } from './trade'

export interface ClaimableMarket {
  market: PublicKey
  collateralMint: PublicKey
  /** The user's YES or NO ATA when missing: claim_winnings takes both, so create them first. */
  createAtas?: readonly AtaSpec[]
}

export interface BuildClaimTxsInput {
  user: PublicKey
  feePayer: PublicKey
  recentBlockhash: string
  markets: readonly ClaimableMarket[]
  /** Close the YES and NO accounts after claiming (claim_winnings empties both). */
  closeAccounts: boolean
  /** Who gets the closed accounts' rent back: the sponsor that paid it, or the user. */
  rentDestination: PublicKey
  /** The user's mUSDC ATA when it does not exist yet: created first, paid by `feePayer`. */
  createCollateralAta?: AtaSpec
}

function compile(input: BuildClaimTxsInput, instructions: TransactionInstruction[]) {
  const message = new TransactionMessage({
    payerKey: input.feePayer,
    recentBlockhash: input.recentBlockhash,
    instructions,
  }).compileToV0Message()
  return new VersionedTransaction(message)
}

function size(tx: VersionedTransaction): number {
  return tx.serialize().length
}

/**
 * Claim every market in as few transactions as fit in 1,232 bytes (spec section 10: "Claim
 * all", split when it does not fit). Each market's claim and its account closes stay together.
 */
export function buildClaimTransactions(input: BuildClaimTxsInput): VersionedTransaction[] {
  const groups = input.markets.map((m) => {
    const ixs: TransactionInstruction[] = [
      ...createAtaIxs(input.feePayer, m.createAtas ?? []),
      buildClaimWinningsIx({
        user: input.user,
        market: m.market,
        collateralMint: m.collateralMint,
      }),
    ]
    if (input.closeAccounts) {
      for (const mint of [deriveYesMint(m.market), deriveNoMint(m.market)]) {
        ixs.push(
          createCloseAccountInstruction(
            ataAddress({ owner: input.user, mint }),
            input.rentDestination,
            input.user,
          ),
        )
      }
    }
    return ixs
  })

  const txs: VersionedTransaction[] = []
  let current: TransactionInstruction[] = input.createCollateralAta
    ? createAtaIxs(input.feePayer, [input.createCollateralAta])
    : []
  let currentClaims = 0
  for (const group of groups) {
    const candidate = [...current, ...group]
    if (size(compile(input, candidate)) <= MAX_TX_BYTES) {
      current = candidate
      currentClaims++
      continue
    }
    if (currentClaims === 0) {
      throw new HoragonError('INVALID_INPUT', 'One claim does not fit in a transaction')
    }
    txs.push(compile(input, current))
    current = group
    currentClaims = 1
  }
  if (currentClaims > 0) txs.push(compile(input, current))
  return txs
}
