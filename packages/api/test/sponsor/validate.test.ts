import { buildClaimTransactions } from '@horagon/sdk'
import {
  DEVNET_MUSDC_MINT,
  PM_AMM_IX_DISCRIMINATORS,
  PM_AMM_PROGRAM_ID,
  type PmAmmInstructionName,
  PROTOCOL_DAO,
} from '@horagon/sdk/pm-amm'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SPONSOR_LIMITS, type SponsorPolicy } from '../../src/sponsor/policy'
import { validateSponsoredTransaction } from '../../src/sponsor/validate'

const key = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey
const sponsor = key(1)
const user = key(2)
const stranger = key(3)
const market = key(4)
const foreignMarket = key(5)
const yesMint = key(6)
const noMint = key(7)
const authority = key(8)
const randomMint = key(9)
const otherMarket = key(10)
const otherYesMint = key(11)
const otherNoMint = key(12)
const usdc = DEVNET_MUSDC_MINT

const outcomeMints = new Map([
  [yesMint.toBase58(), market],
  [noMint.toBase58(), market],
  [otherYesMint.toBase58(), otherMarket],
  [otherNoMint.toBase58(), otherMarket],
])

const policy: SponsorPolicy = {
  sponsor,
  collateralMint: usdc,
  feeOwners: [PROTOCOL_DAO, authority],
  isHoragonMarket: (m) => m.equals(market) || m.equals(otherMarket),
  outcomeMintMarket: (m) => outcomeMints.get(m.toBase58()),
  limits: DEFAULT_SPONSOR_LIMITS,
}

const ata = (owner: PublicKey, mint: PublicKey, payer = sponsor) =>
  createAssociatedTokenAccountIdempotentInstruction(
    payer,
    getAssociatedTokenAddressSync(mint, owner, true),
    owner,
    mint,
  )

function pmAmm(
  name: PmAmmInstructionName,
  opts: { signer?: PublicKey; market?: PublicKey; extra?: PublicKey } = {},
) {
  return new TransactionInstruction({
    programId: PM_AMM_PROGRAM_ID,
    keys: [
      { pubkey: opts.signer ?? user, isSigner: true, isWritable: true },
      { pubkey: opts.market ?? market, isSigner: false, isWritable: true },
      {
        pubkey: opts.extra ?? getAssociatedTokenAddressSync(usdc, user),
        isSigner: false,
        isWritable: true,
      },
    ],
    data: Buffer.from([...PM_AMM_IX_DISCRIMINATORS[name], ...new Array(17).fill(0)]),
  })
}

/**
 * `ix` with the user as a signer. With CloseAccount gone, no allowed instruction but a pm-AMM
 * one has the user sign; this reaches the checks behind the two-signer rule without one.
 */
const userSigns = (ix: TransactionInstruction) =>
  new TransactionInstruction({
    programId: ix.programId,
    data: ix.data,
    keys: ix.keys.map((k) => (k.pubkey.equals(user) ? { ...k, isSigner: true } : k)),
  })

/** The CloseAccount the SDK used to append after claim_winnings, which already closed it. */
const close = (destination = sponsor) =>
  createCloseAccountInstruction(getAssociatedTokenAddressSync(yesMint, user), destination, user)

function build(
  instructions: TransactionInstruction[],
  opts: { payer?: PublicKey; lookups?: AddressLookupTableAccount[] } = {},
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: opts.payer ?? sponsor,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToV0Message(opts.lookups)
  return new VersionedTransaction(message)
}

const BUY = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
  ata(user, yesMint),
  ata(user, noMint),
  ata(user, usdc),
  ata(PROTOCOL_DAO, usdc),
  ata(authority, usdc),
  pmAmm('swap'),
]

describe('validateSponsoredTransaction accepts', () => {
  it('a typical sponsored buy and reports the user', () => {
    const verdict = validateSponsoredTransaction(build(BUY), policy)
    expect(verdict).toEqual({ ok: true, user, ataCreates: 5 })
  })

  it('a claim with nothing after it, creating the missing NO account first', () => {
    const tx = build([ata(user, noMint), pmAmm('claimWinnings')])
    expect(validateSponsoredTransaction(tx, policy)).toEqual({ ok: true, user, ataCreates: 1 })
  })

  it('every claim transaction the SDK builds', () => {
    const txs = buildClaimTransactions({
      user,
      feePayer: sponsor,
      recentBlockhash: PublicKey.default.toBase58(),
      markets: [
        { market, collateralMint: usdc, createAtas: [{ owner: user, mint: noMint }] },
        { market: otherMarket, collateralMint: usdc },
      ],
      createCollateralAta: { owner: user, mint: usdc },
    })
    expect(txs.length).toBeGreaterThan(0)
    for (const tx of txs) expect(validateSponsoredTransaction(tx, policy).ok).toBe(true)
  })

  it('a redeem', () => {
    expect(validateSponsoredTransaction(build([pmAmm('redeemPair')]), policy).ok).toBe(true)
  })
})

describe('validateSponsoredTransaction rejects', () => {
  const lookup = new AddressLookupTableAccount({
    key: key(20),
    state: {
      deactivationSlot: 2n ** 64n - 1n,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: [getAssociatedTokenAddressSync(usdc, user)],
    },
  })

  it.each([
    ['a different fee payer', build([pmAmm('swap')], { payer: user }), 'NOT_FEE_PAYER'],
    ['address lookup tables', build([pmAmm('swap')], { lookups: [lookup] }), 'LOOKUP_TABLES'],
    [
      'a third signer',
      build([
        pmAmm('swap'),
        SystemProgram.transfer({ fromPubkey: stranger, toPubkey: user, lamports: 1 }),
      ]),
      'BAD_SIGNERS',
    ],
    [
      'too many instructions',
      build([
        ...new Array(12).fill(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })),
        pmAmm('swap'),
      ]),
      'TOO_MANY_INSTRUCTIONS',
    ],
    [
      'a CU limit above 1,000,000',
      build([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), pmAmm('swap')]),
      'COMPUTE_BUDGET',
    ],
    [
      'a CU price above the cap',
      build([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_001 }), pmAmm('swap')]),
      'COMPUTE_BUDGET',
    ],
    [
      'a heap frame request',
      build([ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }), pmAmm('swap')]),
      'COMPUTE_BUDGET',
    ],
    [
      'a SOL transfer out of the sponsor',
      build([
        SystemProgram.transfer({ fromPubkey: sponsor, toPubkey: stranger, lamports: 1 }),
        pmAmm('swap'),
      ]),
      'SPONSOR_MISUSE',
    ],
    [
      'any System Program instruction',
      build([
        SystemProgram.transfer({ fromPubkey: user, toPubkey: stranger, lamports: 1 }),
        pmAmm('swap'),
      ]),
      'PROGRAM_NOT_ALLOWED',
    ],
    ['an ATA for a stranger', build([ata(stranger, usdc), pmAmm('swap')]), 'ATA_RULE'],
    ['an ATA for an unknown mint', build([ata(user, randomMint), pmAmm('swap')]), 'ATA_RULE'],
    [
      'a stranger-owned outcome-mint ATA',
      build([ata(stranger, yesMint), pmAmm('swap')]),
      'ATA_RULE',
    ],
    [
      'a fee-owner ATA for an outcome mint',
      build([ata(PROTOCOL_DAO, yesMint), pmAmm('swap')]),
      'ATA_RULE',
    ],
    [
      'more ATA creates than the limit',
      build([
        ata(user, yesMint),
        ata(user, noMint),
        ata(user, usdc),
        ata(PROTOCOL_DAO, usdc),
        ata(authority, usdc),
        ata(user, yesMint),
        pmAmm('swap'),
      ]),
      'ATA_RULE',
    ],
    ['an ATA the user pays for', build([ata(user, yesMint, user), pmAmm('swap')]), 'ATA_RULE'],
    [
      'a non-idempotent ATA create',
      build([
        createAssociatedTokenAccountInstruction(
          sponsor,
          getAssociatedTokenAddressSync(yesMint, user),
          user,
          yesMint,
        ),
        pmAmm('swap'),
      ]),
      'ATA_RULE',
    ],
    [
      'a Token-2022 ATA',
      build([
        createAssociatedTokenAccountIdempotentInstruction(
          sponsor,
          getAssociatedTokenAddressSync(yesMint, user, true, TOKEN_2022_PROGRAM_ID),
          user,
          yesMint,
          TOKEN_2022_PROGRAM_ID,
        ),
        pmAmm('swap'),
      ]),
      'ATA_RULE',
    ],
    [
      'an ATA whose address does not match',
      build([
        createAssociatedTokenAccountIdempotentInstruction(sponsor, key(30), user, yesMint),
        pmAmm('swap'),
      ]),
      'ATA_RULE',
    ],
    [
      'a swap on a market Horagon does not list',
      build([pmAmm('swap', { market: foreignMarket })]),
      'PM_AMM_RULE',
    ],
    ['a deposit_liquidity', build([pmAmm('depositLiquidity')]), 'PM_AMM_RULE'],
    ['a resolve_market', build([pmAmm('resolveMarket')]), 'PM_AMM_RULE'],
    [
      'the sponsor inside the swap accounts',
      build([pmAmm('swap', { extra: sponsor })]),
      'SPONSOR_MISUSE',
    ],
    [
      'an SPL token transfer',
      build([
        createTransferInstruction(
          getAssociatedTokenAddressSync(usdc, user),
          getAssociatedTokenAddressSync(usdc, stranger),
          user,
          1n,
        ),
        pmAmm('swap'),
      ]),
      'PROGRAM_NOT_ALLOWED',
    ],
    // claim_winnings closes the user's YES and NO accounts itself: a CloseAccount after it can
    // only fail on chain, whoever the rent goes to, so the sponsor never pays for one.
    [
      'a close back to the sponsor after a claim',
      build([pmAmm('claimWinnings'), close()]),
      'SPONSOR_MISUSE',
    ],
    [
      'a close to the user after a claim',
      build([pmAmm('claimWinnings'), close(user)]),
      'PROGRAM_NOT_ALLOWED',
    ],
    [
      'a close that sends rent to a stranger',
      build([pmAmm('claimWinnings'), close(stranger)]),
      'PROGRAM_NOT_ALLOWED',
    ],
    [
      'a close the sponsor must authorize',
      build([
        pmAmm('swap'),
        createCloseAccountInstruction(
          getAssociatedTokenAddressSync(usdc, sponsor),
          sponsor,
          sponsor,
        ),
      ]),
      'SPONSOR_MISUSE',
    ],
    [
      'an unknown program',
      build([
        new TransactionInstruction({ programId: key(40), keys: [], data: Buffer.alloc(0) }),
        pmAmm('swap'),
      ]),
      'PROGRAM_NOT_ALLOWED',
    ],
    ['no pm-AMM instruction at all', build([userSigns(ata(user, usdc))]), 'NO_TRADE'],
    [
      'a pm-AMM instruction whose first account is not the user',
      build([
        new TransactionInstruction({
          programId: PM_AMM_PROGRAM_ID,
          keys: [
            { pubkey: stranger, isSigner: false, isWritable: true },
            { pubkey: market, isSigner: false, isWritable: true },
          ],
          data: Buffer.from(PM_AMM_IX_DISCRIMINATORS.swap),
        }),
        pmAmm('swap'),
      ]),
      'PM_AMM_RULE',
    ],
  ])('%s', (_label, tx, reason) => {
    const verdict = validateSponsoredTransaction(tx, policy)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe(reason)
  })
})

// Each outcome ATA costs the sponsor rent the user can later reclaim: it must serve a market the
// transaction itself trades, or one tiny swap could farm creates for every Horagon market.
describe('validateSponsoredTransaction ties outcome ATAs to the traded markets', () => {
  const verdictOf = (instructions: TransactionInstruction[]) =>
    validateSponsoredTransaction(build(instructions), policy)

  it('accepts the YES and NO ATAs of the market a swap trades', () => {
    expect(verdictOf([ata(user, yesMint), ata(user, noMint), pmAmm('swap')])).toEqual({
      ok: true,
      user,
      ataCreates: 2,
    })
  })

  it.each(['redeemPair', 'claimWinnings'] as const)(
    'accepts the outcome ATAs of the market a %s touches',
    (name) => {
      expect(verdictOf([ata(user, yesMint), ata(user, noMint), pmAmm(name)])).toEqual({
        ok: true,
        user,
        ataCreates: 2,
      })
    },
  )

  it('accepts outcome ATAs of each market the transaction trades', () => {
    const tx = [
      ata(user, yesMint),
      ata(user, otherNoMint),
      pmAmm('swap'),
      pmAmm('swap', { market: otherMarket }),
    ]
    expect(verdictOf(tx)).toEqual({ ok: true, user, ataCreates: 2 })
  })

  it('counts the ATA creates of the S3a sponsored swap', () => {
    const s3a = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      ata(user, yesMint),
      ata(user, noMint),
      ata(PROTOCOL_DAO, usdc),
      ata(authority, usdc),
      pmAmm('swap'),
    ]
    expect(verdictOf(s3a)).toEqual({ ok: true, user, ataCreates: 4 })
  })

  it.each([
    ['a swap on another market', [ata(user, otherYesMint), pmAmm('swap')], otherMarket],
    ['no pm-AMM instruction', [userSigns(ata(user, yesMint))], market],
  ])('refuses an outcome ATA with %s and names its market', (_label, instructions, mintMarket) => {
    const verdict = verdictOf(instructions)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.reason).toBe('ATA_RULE')
      expect(verdict.detail).toContain(`market ${mintMarket.toBase58()}`)
      expect(verdict.detail).toContain('does not trade')
    }
  })
})

// Review Focus: wallets may still produce legacy (non-v0) messages.
describe('validateSponsoredTransaction on legacy messages', () => {
  const legacy = (instructions: TransactionInstruction[]) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: sponsor,
        recentBlockhash: PublicKey.default.toBase58(),
        instructions,
      }).compileToLegacyMessage(),
    )

  it('applies the same allowlist as to v0 messages', () => {
    expect(validateSponsoredTransaction(legacy(BUY), policy)).toEqual({
      ok: true,
      user,
      ataCreates: 5,
    })
    const verdict = validateSponsoredTransaction(legacy([pmAmm('depositLiquidity')]), policy)
    expect(verdict.ok ? undefined : verdict.reason).toBe('PM_AMM_RULE')
  })
})

describe('validateSponsoredTransaction property', () => {
  const good: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ata(user, yesMint),
    ata(user, noMint),
    ata(user, usdc),
    ata(PROTOCOL_DAO, usdc),
    ata(authority, usdc),
    pmAmm('redeemPair'),
    pmAmm('claimWinnings'),
  ]
  const bad: TransactionInstruction[] = [
    close(),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_001 }),
    SystemProgram.transfer({ fromPubkey: sponsor, toPubkey: stranger, lamports: 5_000 }),
    SystemProgram.transfer({ fromPubkey: user, toPubkey: stranger, lamports: 5_000 }),
    ata(stranger, usdc),
    ata(user, randomMint),
    pmAmm('swap', { market: foreignMarket }),
    pmAmm('withdrawLiquidity'),
    close(stranger),
    new TransactionInstruction({ programId: key(41), keys: [], data: Buffer.from([1]) }),
  ]
  const atom = fc.oneof(
    fc.constantFrom(...good).map((ix) => ({ ix, ok: true })),
    fc.constantFrom(...bad).map((ix) => ({ ix, ok: false })),
  )

  it('accepts a transaction exactly when every instruction is on the allowlist', () => {
    fc.assert(
      fc.property(fc.array(atom, { maxLength: 10 }), (atoms) => {
        const ixs = atoms.map((a) => a.ix)
        const tx = build([pmAmm('swap'), ...ixs])
        const verdict = validateSponsoredTransaction(tx, policy)
        const ataCreates = ixs.filter((ix) =>
          ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID),
        ).length
        expect(verdict.ok).toBe(
          atoms.every((a) => a.ok) && ataCreates <= DEFAULT_SPONSOR_LIMITS.maxAtaCreates,
        )
      }),
      { numRuns: 500 },
    )
  })
})
