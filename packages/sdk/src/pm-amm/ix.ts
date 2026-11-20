// The three pm-AMM instructions a player sends (spec section 9 allowlist: swap, redeem_pair,
// claim_winnings), encoded by hand so the SDK needs no Anchor client in the browser. The
// account order and argument layout follow the vendored IDL; test/pm-amm/ix.test.ts checks
// every builder against the vendored Anchor builder, byte for byte.
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { type PublicKey, TransactionInstruction } from '@solana/web3.js'
import { Buffer } from 'buffer'
import { HoragonError } from '../errors'
import type { SwapDirection } from '../math/curve'
import { PM_AMM_PROGRAM_ID, PROTOCOL_DAO } from './constants'
import { PM_AMM_IX_DISCRIMINATORS } from './instructions'
import { deriveNoMint, deriveVault, deriveYesMint } from './pda'

/** Borsh variant index of pm-AMM's `SwapDirection` enum (IDL order). */
export const SWAP_DIRECTION_INDEX: Readonly<Record<SwapDirection, number>> = {
  usdcToYes: 0,
  usdcToNo: 1,
  yesToUsdc: 2,
  noToUsdc: 3,
  yesToNo: 4,
  noToYes: 5,
}

const U64_MAX = 2n ** 64n - 1n

function data(discriminator: readonly number[], ...fields: Array<number | bigint>): Buffer {
  const out = Buffer.alloc(
    8 + fields.reduce<number>((n, f) => n + (typeof f === 'number' ? 1 : 8), 0),
  )
  out.set(discriminator, 0)
  let offset = 8
  for (const f of fields) {
    if (typeof f === 'number') {
      out.writeUInt8(f, offset)
      offset += 1
    } else {
      if (f < 0n || f > U64_MAX) throw new HoragonError('INVALID_INPUT', `u64 out of range: ${f}`)
      out.writeBigUInt64LE(f, offset)
      offset += 8
    }
  }
  return out
}

const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true })
const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false })
const signer = (pubkey: PublicKey) => ({ pubkey, isSigner: true, isWritable: true })
const ata = (mint: PublicKey, owner: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID)

export interface MarketKeys {
  market: PublicKey
  collateralMint: PublicKey
  /** `market.authority`: receives the creator half of the fee (Horagon's Authority PDA). */
  authority: PublicKey
}

export interface SwapIxInput extends MarketKeys {
  user: PublicKey
  direction: SwapDirection
  amountIn: bigint
  minOut: bigint
}

export function buildSwapIx(p: SwapIxInput): TransactionInstruction {
  if (p.authority.equals(p.user)) {
    // pm-AMM then expects no creator account; Horagon players are never the authority.
    throw new HoragonError('INVALID_INPUT', 'The market authority cannot swap through this builder')
  }
  const yesMint = deriveYesMint(p.market)
  const noMint = deriveNoMint(p.market)
  return new TransactionInstruction({
    programId: PM_AMM_PROGRAM_ID,
    keys: [
      signer(p.user),
      w(p.market),
      r(p.collateralMint),
      w(yesMint),
      w(noMint),
      w(deriveVault(p.market)),
      w(ata(p.collateralMint, p.user)),
      w(ata(yesMint, p.user)),
      w(ata(noMint, p.user)),
      w(ata(p.collateralMint, PROTOCOL_DAO)),
      w(ata(p.collateralMint, p.authority)),
      r(TOKEN_PROGRAM_ID),
    ],
    data: data(
      PM_AMM_IX_DISCRIMINATORS.swap,
      SWAP_DIRECTION_INDEX[p.direction],
      p.amountIn,
      p.minOut,
    ),
  })
}

export interface ClaimIxInput {
  user: PublicKey
  market: PublicKey
  collateralMint: PublicKey
}

/** claim_winnings: burns YES and NO, pays the winning side 1:1. `amount` is ignored on chain. */
export function buildClaimWinningsIx(p: ClaimIxInput): TransactionInstruction {
  return new TransactionInstruction({
    programId: PM_AMM_PROGRAM_ID,
    keys: payoutKeys(p),
    data: data(PM_AMM_IX_DISCRIMINATORS.claimWinnings, 1n),
  })
}

/** redeem_pair: burns `amount` YES + `amount` NO for `amount` collateral; valid at any time. */
export function buildRedeemPairIx(p: ClaimIxInput & { amount: bigint }): TransactionInstruction {
  return new TransactionInstruction({
    programId: PM_AMM_PROGRAM_ID,
    keys: payoutKeys(p),
    data: data(PM_AMM_IX_DISCRIMINATORS.redeemPair, p.amount),
  })
}

/** claim_winnings and redeem_pair share one account list. */
function payoutKeys(p: ClaimIxInput) {
  const yesMint = deriveYesMint(p.market)
  const noMint = deriveNoMint(p.market)
  return [
    signer(p.user),
    r(p.market),
    r(p.collateralMint),
    w(yesMint),
    w(noMint),
    w(deriveVault(p.market)),
    w(ata(yesMint, p.user)),
    w(ata(noMint, p.user)),
    w(ata(p.collateralMint, p.user)),
    r(TOKEN_PROGRAM_ID),
  ]
}
