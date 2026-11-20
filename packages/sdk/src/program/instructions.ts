// Hand-encoded instructions of the `horagon` program. Account order, signer and writable
// flags and argument layout are the program's wire format (programs/horagon/src/lib.rs);
// test/program/idl-contract.test.ts compares every builder with the IDL that `anchor build`
// generates, so a change on either side fails CI.
import {
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  type AccountMeta,
  type PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import { Buffer } from 'buffer'
import { HoragonError } from '../errors'
import { METAPLEX_PROGRAM_ID, PM_AMM_PROGRAM_ID } from '../pm-amm/constants'
import type { Outcome } from '../schemas'
import { asciiField, BorshWriter } from './borsh'
import {
  HORAGON_PROGRAM_ID,
  MAX_DISPUTE_WINDOW_SECS,
  MAX_EVIDENCE_URI_LEN,
  MAX_EXTERNAL_ID_LEN,
  MAX_MARKET_NAME_LEN,
  MAX_PRICE_BPS,
  MIN_DISPUTE_WINDOW_SECS,
  MIN_PRICE_BPS,
} from './constants'
import {
  deriveAuthority,
  deriveConfig,
  deriveProgramData,
  deriveTreasury,
  type MarketKindCode,
  marketAddresses,
} from './pda'

/** sha256("global:<snake_case name>")[0..8]. */
export const HORAGON_IX_DISCRIMINATORS = {
  initializeConfig: [208, 127, 21, 1, 194, 190, 196, 70],
  updateConfig: [29, 158, 252, 191, 10, 83, 219, 99],
  createGameMarket: [148, 192, 129, 123, 150, 214, 44, 103],
  halt: [24, 156, 8, 121, 65, 3, 5, 82],
  proposeResult: [7, 96, 132, 38, 128, 145, 133, 242],
  challenge: [16, 107, 14, 39, 244, 150, 81, 187],
  finalize: [171, 61, 218, 56, 127, 115, 12, 217],
  recycle: [189, 68, 138, 58, 52, 146, 33, 17],
  withdrawTreasury: [40, 63, 122, 158, 144, 216, 83, 96],
} as const

export type HoragonInstructionName = keyof typeof HORAGON_IX_DISCRIMINATORS

const IX_ENTRIES = Object.entries(HORAGON_IX_DISCRIMINATORS) as Array<
  [HoragonInstructionName, readonly number[]]
>

/** Which `horagon` instruction this data encodes, or undefined. */
export function horagonInstructionName(data: Uint8Array): HoragonInstructionName | undefined {
  if (data.length < 8) return undefined
  for (const [name, disc] of IX_ENTRIES) {
    if (disc.every((b, i) => data[i] === b)) return name
  }
  return undefined
}

/** 0 = Yes (home wins / home takes the second half), 1 = No. Borsh variant index. */

export const OUTCOME_INDEX: Readonly<Record<Outcome, number>> = { yes: 0, no: 1 }

const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true })
const r = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false })
const s = (pubkey: PublicKey, isWritable: boolean): AccountMeta => ({
  pubkey,
  isSigner: true,
  isWritable,
})

function ix(
  name: HoragonInstructionName,
  keys: AccountMeta[],
  args: Buffer,
  programId: PublicKey,
): TransactionInstruction {
  const data = Buffer.concat([Buffer.from(HORAGON_IX_DISCRIMINATORS[name]), args])
  return new TransactionInstruction({ programId, keys, data })
}

export interface ProgramIds {
  programId?: PublicKey
  pmAmmProgramId?: PublicKey
}

export interface InitializeConfigParams extends ProgramIds {
  /** The program's upgrade authority; becomes `admin`. */
  admin: PublicKey
  attestor: PublicKey
  /** Guardian 1 (the operator) and guardian 2 (watcher, Tier 2; `PublicKey.default` until then). */
  guardians: [PublicKey, PublicKey]
  disputeWindowSecs: number
  collateralMint: PublicKey
}

export function buildInitializeConfigIx(p: InitializeConfigParams): TransactionInstruction {
  const programId = p.programId ?? HORAGON_PROGRAM_ID
  if (p.disputeWindowSecs > MAX_DISPUTE_WINDOW_SECS) {
    throw new HoragonError('INVALID_INPUT', `dispute window above ${MAX_DISPUTE_WINDOW_SECS} s`)
  }
  if (p.disputeWindowSecs < MIN_DISPUTE_WINDOW_SECS) {
    throw new HoragonError('INVALID_INPUT', `dispute window below ${MIN_DISPUTE_WINDOW_SECS} s`)
  }
  const args = new BorshWriter()
    .pubkey(p.attestor)
    .pubkey(p.guardians[0])
    .pubkey(p.guardians[1])
    .u32(p.disputeWindowSecs, 'disputeWindowSecs')
    .pubkey(p.collateralMint)
    .toBuffer()
  return ix(
    'initializeConfig',
    [
      s(p.admin, true),
      w(deriveConfig(programId)),
      r(programId),
      r(deriveProgramData(programId)),
      r(SystemProgram.programId),
    ],
    args,
    programId,
  )
}

export interface UpdateConfigParams extends ProgramIds {
  admin: PublicKey
  attestor?: PublicKey
  guardians?: [PublicKey, PublicKey]
  disputeWindowSecs?: number
  creationPaused?: boolean
}

export function buildUpdateConfigIx(p: UpdateConfigParams): TransactionInstruction {
  const programId = p.programId ?? HORAGON_PROGRAM_ID
  if (p.disputeWindowSecs !== undefined) {
    if (p.disputeWindowSecs > MAX_DISPUTE_WINDOW_SECS) {
      throw new HoragonError('INVALID_INPUT', `dispute window above ${MAX_DISPUTE_WINDOW_SECS} s`)
    }
    if (p.disputeWindowSecs < MIN_DISPUTE_WINDOW_SECS) {
      throw new HoragonError('INVALID_INPUT', `dispute window below ${MIN_DISPUTE_WINDOW_SECS} s`)
    }
  }
  const args = new BorshWriter()
    .option(p.attestor, (wr, v) => wr.pubkey(v))
    .option(p.guardians, (wr, v) => wr.pubkey(v[0]).pubkey(v[1]))
    .option(p.disputeWindowSecs, (wr, v) => wr.u32(v, 'disputeWindowSecs'))
    .option(p.creationPaused, (wr, v) => wr.bool(v))
    .toBuffer()
  return ix('updateConfig', [s(p.admin, false), w(deriveConfig(programId))], args, programId)
}

export interface CreateGameMarketParams extends ProgramIds {
  attestor: PublicKey
  collateralMint: PublicKey
  marketId: bigint
  kind: MarketKindCode
  league: string
  externalGameId: string
  home: string
  away: string
  /** Unix seconds. */
  scheduledTipoff: number
  /** Unix seconds; at least 300 s after the chain clock. */
  endTs: number
  name: string
  initialPriceBps: number
  /** Raw mUSDC (6 decimals) moved from the treasury into the pool. */
  seedAmount: bigint
}

export function buildCreateGameMarketIx(p: CreateGameMarketParams): TransactionInstruction {
  const programId = p.programId ?? HORAGON_PROGRAM_ID
  const pmAmm = p.pmAmmProgramId ?? PM_AMM_PROGRAM_ID
  if (p.initialPriceBps < MIN_PRICE_BPS || p.initialPriceBps > MAX_PRICE_BPS) {
    throw new HoragonError('INVALID_INPUT', `initialPriceBps must be in [500, 9500]`)
  }
  if (p.externalGameId.length === 0) throw new HoragonError('INVALID_INPUT', 'empty externalGameId')
  if (p.name.length === 0) throw new HoragonError('INVALID_INPUT', 'empty market name')
  if (p.seedAmount <= 0n) throw new HoragonError('INVALID_INPUT', 'seedAmount must be positive')
  const a = marketAddresses(p.marketId, programId, pmAmm)
  const args = new BorshWriter()
    .u64(p.marketId, 'marketId')
    .u8(p.kind, 'kind')
    .fixed(asciiField(p.league, 8, 'league'), 8)
    .string(p.externalGameId, MAX_EXTERNAL_ID_LEN, 'externalGameId')
    .fixed(asciiField(p.home, 4, 'home'), 4)
    .fixed(asciiField(p.away, 4, 'away'), 4)
    .i64(p.scheduledTipoff, 'scheduledTipoff')
    .i64(p.endTs, 'endTs')
    .string(p.name, MAX_MARKET_NAME_LEN, 'name')
    .u16(p.initialPriceBps, 'initialPriceBps')
    .u64(p.seedAmount, 'seedAmount')
    .toBuffer()
  return ix(
    'createGameMarket',
    [
      s(p.attestor, true),
      r(deriveConfig(programId)),
      w(a.authority),
      w(a.gameMarket),
      w(a.market),
      r(p.collateralMint),
      w(a.yesMint),
      w(a.noMint),
      w(a.vault),
      w(a.yesMetadata),
      w(a.noMetadata),
      w(deriveTreasury(p.collateralMint, programId)),
      w(a.lpPosition),
      r(METAPLEX_PROGRAM_ID),
      r(pmAmm),
      r(SystemProgram.programId),
      r(TOKEN_PROGRAM_ID),
      r(SYSVAR_RENT_PUBKEY),
    ],
    args,
    programId,
  )
}

export interface MarketIxParams extends ProgramIds {
  marketId: bigint
}

export interface HaltParams extends MarketIxParams {
  /** Attestor or a guardian. */
  signer: PublicKey
  collateralMint: PublicKey
}

/** Needs the Authority's YES and NO ATAs to exist: prepend `authorityOutcomeAtaIxs`. */
export function buildHaltIx(p: HaltParams): TransactionInstruction {
  const programId = p.programId ?? HORAGON_PROGRAM_ID
  const pmAmm = p.pmAmmProgramId ?? PM_AMM_PROGRAM_ID
  const a = marketAddresses(p.marketId, programId, pmAmm)
  return ix(
    'halt',
    [
      s(p.signer, false),
      r(deriveConfig(programId)),
      w(a.authority),
      w(a.gameMarket),
      w(a.market),
      r(p.collateralMint),
      w(a.yesMint),
      w(a.noMint),
      w(a.lpPosition),
      w(a.authorityYes),
      w(a.authorityNo),
      r(pmAmm),
      r(TOKEN_PROGRAM_ID),
    ],
    Buffer.alloc(0),
    programId,
  )
}

export interface ProposeResultParams extends MarketIxParams {
  /** Attestor or a guardian. */
  signer: PublicKey
  outcome: Outcome
  /** sha256 of the JCS evidence, 32 bytes. */
  evidenceHash: Uint8Array
  /** Where the evidence JSON is published (`/api/v1/evidence/{gameId}/{kind}`). */
  evidenceUri: string
}

export function buildProposeResultIx(p: ProposeResultParams): TransactionInstruction {
  const programId = p.programId ?? HORAGON_PROGRAM_ID
  const a = marketAddresses(p.marketId, programId, p.pmAmmProgramId ?? PM_AMM_PROGRAM_ID)
  if (p.evidenceHash.every((b) => b === 0)) {
    throw new HoragonError('INVALID_INPUT', 'evidenceHash is all zero')
  }
  if (p.evidenceUri.length === 0) throw new HoragonError('INVALID_INPUT', 'empty evidenceUri')
  const args = new BorshWriter()
    .u8(OUTCOME_INDEX[p.outcome], 'outcome')
    .fixed(p.evidenceHash, 32, 'evidenceHash')
    .string(p.evidenceUri, MAX_EVIDENCE_URI_LEN, 'evidenceUri')
    .toBuffer()
  return ix(
    'proposeResult',
    [s(p.signer, false), r(deriveConfig(programId)), w(a.gameMarket), r(a.market)],
    args,
    programId,
  )
}

export interface ChallengeParams extends MarketIxParams {
  guardian: PublicKey
}

export function buildChallengeIx(p: ChallengeParams): TransactionInstruction {
  const programId = p.programId ?? HORAGON_PROGRAM_ID
  const a = marketAddresses(p.marketId, programId, p.pmAmmProgramId ?? PM_AMM_PROGRAM_ID)
  return ix(
    'challenge',
    [s(p.guardian, false), r(deriveConfig(programId)), w(a.gameMarket), r(a.market)],
    Buffer.alloc(0),
    programId,
  )
}

/** Anyone may finalize once the window has passed; the fee payer is the only signer. */
export function buildFinalizeIx(p: MarketIxParams): TransactionInstruction {
  const programId = p.programId ?? HORAGON_PROGRAM_ID
  const pmAmm = p.pmAmmProgramId ?? PM_AMM_PROGRAM_ID
  const a = marketAddresses(p.marketId, programId, pmAmm)
  return ix(
    'finalize',
    [r(deriveConfig(programId)), r(a.authority), w(a.gameMarket), w(a.market), r(pmAmm)],
    Buffer.alloc(0),
    programId,
  )
}

export interface RecycleParams extends MarketIxParams {
  collateralMint: PublicKey
}

/** Needs the Authority's YES and NO ATAs to exist: prepend `authorityOutcomeAtaIxs`. */
export function buildRecycleIx(p: RecycleParams): TransactionInstruction {
  const programId = p.programId ?? HORAGON_PROGRAM_ID
  const pmAmm = p.pmAmmProgramId ?? PM_AMM_PROGRAM_ID
  const a = marketAddresses(p.marketId, programId, pmAmm)
  return ix(
    'recycle',
    [
      r(deriveConfig(programId)),
      w(a.authority),
      w(a.gameMarket),
      w(a.market),
      r(p.collateralMint),
      w(a.yesMint),
      w(a.noMint),
      w(a.vault),
      w(a.lpPosition),
      w(a.authorityYes),
      w(a.authorityNo),
      w(deriveTreasury(p.collateralMint, programId)),
      r(pmAmm),
      r(TOKEN_PROGRAM_ID),
    ],
    Buffer.alloc(0),
    programId,
  )
}

export interface WithdrawTreasuryParams extends ProgramIds {
  admin: PublicKey
  collateralMint: PublicKey
  /** An mUSDC token account (not a wallet). */
  destination: PublicKey
  amount: bigint
}

export function buildWithdrawTreasuryIx(p: WithdrawTreasuryParams): TransactionInstruction {
  const programId = p.programId ?? HORAGON_PROGRAM_ID
  if (p.amount <= 0n) throw new HoragonError('INVALID_INPUT', 'amount must be positive')
  return ix(
    'withdrawTreasury',
    [
      s(p.admin, false),
      r(deriveConfig(programId)),
      r(deriveAuthority(programId)),
      w(deriveTreasury(p.collateralMint, programId)),
      w(p.destination),
      r(TOKEN_PROGRAM_ID),
    ],
    new BorshWriter().u64(p.amount, 'amount').toBuffer(),
    programId,
  )
}

/**
 * Idempotent creates of the Authority's YES and NO ATAs, paid by `payer`. `halt` and `recycle`
 * take them as token accounts, so they must exist; the second call is a no-op on chain.
 */
export function authorityOutcomeAtaIxs(
  payer: PublicKey,
  p: MarketIxParams,
): TransactionInstruction[] {
  const a = marketAddresses(
    p.marketId,
    p.programId ?? HORAGON_PROGRAM_ID,
    p.pmAmmProgramId ?? PM_AMM_PROGRAM_ID,
  )
  return [
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      a.authorityYes,
      a.authority,
      a.yesMint,
    ),
    createAssociatedTokenAccountIdempotentInstruction(payer, a.authorityNo, a.authority, a.noMint),
  ]
}
