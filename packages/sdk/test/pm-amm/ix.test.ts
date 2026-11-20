import { PmAmmClient } from '@horagon/pm-amm-vendor'
import { Connection, Keypair, type TransactionInstruction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { SWAP_DIRECTIONS } from '../../src/math/curve'
import { DEVNET_MUSDC_MINT, PM_AMM_PROGRAM_ID } from '../../src/pm-amm/constants'
import { buildClaimWinningsIx, buildRedeemPairIx, buildSwapIx } from '../../src/pm-amm/ix'

// The vendored Anchor client is the oracle. It needs a Connection object but, with the
// authority given explicitly, never talks to it.
const vendor = PmAmmClient.readOnly(
  new Connection('http://127.0.0.1:1'),
  PM_AMM_PROGRAM_ID,
  DEVNET_MUSDC_MINT,
)
const user = Keypair.generate().publicKey
const market = Keypair.generate().publicKey
const authority = Keypair.generate().publicKey

function same(ours: TransactionInstruction, theirs: TransactionInstruction): void {
  expect(ours.programId.toBase58()).toBe(theirs.programId.toBase58())
  expect(Buffer.from(ours.data).toString('hex')).toBe(Buffer.from(theirs.data).toString('hex'))
  const keys = (ix: TransactionInstruction) =>
    ix.keys.map(
      (k) => `${k.pubkey.toBase58()}:${k.isSigner ? 's' : '-'}${k.isWritable ? 'w' : '-'}`,
    )
  expect(keys(ours)).toEqual(keys(theirs))
}

describe('pm-AMM player instructions match the vendored Anchor builder', () => {
  it.each(SWAP_DIRECTIONS)('swap %s', async (direction) => {
    const ours = buildSwapIx({
      user,
      market,
      collateralMint: DEVNET_MUSDC_MINT,
      authority,
      direction,
      amountIn: 12_345_678n,
      minOut: 9_876_543n,
    })
    const theirs = await vendor.ix.swap({
      signer: user,
      market,
      direction,
      amountIn: 12_345_678,
      minOutput: 9_876_543,
      creatorAuthority: authority,
      collateralMint: DEVNET_MUSDC_MINT,
    })
    same(ours, theirs)
  })

  it('claim_winnings', async () => {
    same(
      buildClaimWinningsIx({ user, market, collateralMint: DEVNET_MUSDC_MINT }),
      await vendor.ix.claimWinnings({ signer: user, market, collateralMint: DEVNET_MUSDC_MINT }),
    )
  })

  it('redeem_pair', async () => {
    same(
      buildRedeemPairIx({ user, market, collateralMint: DEVNET_MUSDC_MINT, amount: 5_000_000n }),
      await vendor.ix.redeemPair({
        signer: user,
        market,
        amount: 5_000_000,
        collateralMint: DEVNET_MUSDC_MINT,
      }),
    )
  })
})

describe('buildSwapIx guards', () => {
  it('refuses the authority as the swapper', () => {
    expect(() =>
      buildSwapIx({
        user: authority,
        market,
        collateralMint: DEVNET_MUSDC_MINT,
        authority,
        direction: 'usdcToYes',
        amountIn: 1n,
        minOut: 0n,
      }),
    ).toThrow(/authority cannot swap/)
  })

  it('refuses amounts outside u64', () => {
    expect(() =>
      buildSwapIx({
        user,
        market,
        collateralMint: DEVNET_MUSDC_MINT,
        authority,
        direction: 'usdcToYes',
        amountIn: 2n ** 64n,
        minOut: 0n,
      }),
    ).toThrow(/u64 out of range/)
  })
})
