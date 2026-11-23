import { PM_AMM_PROGRAM_ID, pmAmmInstructionName } from '@horagon/sdk/pm-amm'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  type MessageCompiledInstruction,
  type PublicKey,
  SystemProgram,
  type VersionedTransaction,
} from '@solana/web3.js'
import type { SponsorPolicy, SponsorRejection, SponsorVerdict } from './policy'

const ATA_CREATE_IDEMPOTENT = 1
const CB_SET_COMPUTE_UNIT_LIMIT = 2
const CB_SET_COMPUTE_UNIT_PRICE = 3
/** The only pm-AMM instructions a player may get sponsored. */
const SPONSORED_PM_AMM = new Set(['swap', 'redeemPair', 'claimWinnings'])

class Rejected extends Error {
  constructor(
    readonly reason: SponsorRejection,
    readonly detail: string,
  ) {
    super(detail)
  }
}

function reject(reason: SponsorRejection, detail: string): never {
  throw new Rejected(reason, detail)
}

function same(a: PublicKey | undefined, b: PublicKey): boolean {
  return a?.equals(b) ?? false
}

function checkComputeBudget(data: Uint8Array, policy: SponsorPolicy): void {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (data[0] === CB_SET_COMPUTE_UNIT_LIMIT && data.length === 5) {
    const units = view.getUint32(1, true)
    if (units > policy.limits.maxComputeUnits) {
      reject('COMPUTE_BUDGET', `CU limit ${units} exceeds ${policy.limits.maxComputeUnits}`)
    }
    return
  }
  if (data[0] === CB_SET_COMPUTE_UNIT_PRICE && data.length === 9) {
    const price = view.getBigUint64(1, true)
    if (price > policy.limits.maxMicroLamportsPerCu) {
      reject('COMPUTE_BUDGET', `CU price ${price} exceeds ${policy.limits.maxMicroLamportsPerCu}`)
    }
    return
  }
  reject('COMPUTE_BUDGET', 'Only SetComputeUnitLimit and SetComputeUnitPrice are allowed')
}

function checkAta(
  accounts: Array<PublicKey | undefined>,
  data: Uint8Array,
  user: PublicKey,
  tradedMarkets: readonly PublicKey[],
  policy: SponsorPolicy,
): void {
  if (data.length !== 1 || data[0] !== ATA_CREATE_IDEMPOTENT || accounts.length !== 6) {
    reject('ATA_RULE', 'Only CreateIdempotent is allowed')
  }
  const [payer, ata, owner, mint, systemProgram, tokenProgram] = accounts
  if (!same(payer, policy.sponsor)) reject('ATA_RULE', 'The ATA payer must be the sponsor')
  if (!owner || !mint || !ata) reject('ATA_RULE', 'Missing ATA accounts')
  if (!same(systemProgram, SystemProgram.programId) || !same(tokenProgram, TOKEN_PROGRAM_ID)) {
    reject('ATA_RULE', 'ATA must use the System and SPL Token programs')
  }
  if (!getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID).equals(ata)) {
    reject('ATA_RULE', 'ATA address does not match owner and mint')
  }
  const isCollateral = mint.equals(policy.collateralMint)
  const outcomeOf = owner.equals(user) && !isCollateral ? policy.outcomeMintMarket(mint) : undefined
  if (outcomeOf && !tradedMarkets.some((m) => m.equals(outcomeOf))) {
    reject(
      'ATA_RULE',
      `Mint ${mint.toBase58()} belongs to market ${outcomeOf.toBase58()}, which this transaction does not trade`,
    )
  }
  const userAta = owner.equals(user) && (isCollateral || outcomeOf !== undefined)
  const feeAta = isCollateral && policy.feeOwners.some((f) => f.equals(owner))
  if (!userAta && !feeAta) {
    reject(
      'ATA_RULE',
      `ATA for owner ${owner.toBase58()} and mint ${mint.toBase58()} is not allowed`,
    )
  }
}

function checkPmAmm(
  accounts: Array<PublicKey | undefined>,
  data: Uint8Array,
  user: PublicKey,
  policy: SponsorPolicy,
): void {
  const name = pmAmmInstructionName(data)
  if (!name || !SPONSORED_PM_AMM.has(name)) {
    reject('PM_AMM_RULE', `pm-AMM instruction ${name ?? 'unknown'} is not sponsored`)
  }
  if (!same(accounts[0], user)) reject('PM_AMM_RULE', 'The pm-AMM signer must be the user')
  const market = accounts[1]
  if (!market || !policy.isHoragonMarket(market)) {
    reject('PM_AMM_RULE', `Market ${market?.toBase58() ?? '?'} is not a Horagon market`)
  }
}

/** Where the sponsor key may appear inside an instruction's account list: the ATA payer only. */
function sponsorSlotAllowed(program: PublicKey, position: number): boolean {
  return program.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && position === 0
}

/**
 * First pass: the markets the transaction's own pm-AMM instructions name, at the position
 * `checkPmAmm` reads. Nothing is checked here; the second pass rejects any bad pm-AMM instruction.
 */
function tradedMarkets(
  keys: readonly PublicKey[],
  instructions: readonly MessageCompiledInstruction[],
): PublicKey[] {
  const markets: PublicKey[] = []
  for (const ix of instructions) {
    const [, market] = ix.accountKeyIndexes.map((i) => keys[i])
    if (same(keys[ix.programIdIndex], PM_AMM_PROGRAM_ID) && market) markets.push(market)
  }
  return markets
}

function validate(
  tx: VersionedTransaction,
  policy: SponsorPolicy,
): { user: PublicKey; ataCreates: number } {
  const msg = tx.message
  if (msg.addressTableLookups.length > 0) {
    reject('LOOKUP_TABLES', 'Address lookup tables are not allowed')
  }
  const keys = msg.staticAccountKeys
  if (!same(keys[0], policy.sponsor)) reject('NOT_FEE_PAYER', 'The sponsor must be the fee payer')
  const user = keys[1]
  if (msg.header.numRequiredSignatures !== 2 || !user || user.equals(policy.sponsor)) {
    reject('BAD_SIGNERS', 'Expected exactly two signers: the sponsor, then the user')
  }
  const instructions = msg.compiledInstructions
  if (instructions.length > policy.limits.maxInstructions) {
    reject('TOO_MANY_INSTRUCTIONS', `More than ${policy.limits.maxInstructions} instructions`)
  }

  const traded = tradedMarkets(keys, instructions)
  let trades = 0
  let ataCreates = 0
  for (const ix of instructions) {
    const program = keys[ix.programIdIndex]
    if (!program) reject('PROGRAM_NOT_ALLOWED', 'Program index out of range')
    const accounts = ix.accountKeyIndexes.map((i) => keys[i])
    accounts.forEach((account, position) => {
      if (same(account, policy.sponsor) && !sponsorSlotAllowed(program, position)) {
        reject('SPONSOR_MISUSE', `Sponsor used as account ${position} of ${program.toBase58()}`)
      }
    })
    if (program.equals(ComputeBudgetProgram.programId)) checkComputeBudget(ix.data, policy)
    else if (program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (++ataCreates > policy.limits.maxAtaCreates) {
        reject('ATA_RULE', `More than ${policy.limits.maxAtaCreates} ATA creates`)
      }
      checkAta(accounts, ix.data, user, traded, policy)
    } else if (program.equals(PM_AMM_PROGRAM_ID)) {
      checkPmAmm(accounts, ix.data, user, policy)
      trades++
    } else {
      // SPL Token included: Horagon builds no Token instruction for a player. claim_winnings
      // closes the YES and NO accounts itself, so a CloseAccount after it can only fail.
      reject('PROGRAM_NOT_ALLOWED', `Program ${program.toBase58()} is not allowed`)
    }
  }
  if (trades === 0) reject('NO_TRADE', 'A sponsored transaction must contain a pm-AMM instruction')
  return { user, ataCreates }
}

/**
 * Decide whether the sponsor may co-sign `tx` (spec section 9). Every top-level instruction
 * must match the allowlist; anything else, or any odd use of the sponsor key, is rejected.
 */
export function validateSponsoredTransaction(
  tx: VersionedTransaction,
  policy: SponsorPolicy,
): SponsorVerdict {
  try {
    return { ok: true, ...validate(tx, policy) }
  } catch (e) {
    if (e instanceof Rejected) return { ok: false, reason: e.reason, detail: e.detail }
    throw e
  }
}
