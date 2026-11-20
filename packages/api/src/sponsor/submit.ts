// POST /tx/submit (spec 9), hardened per the Tier 0 S3a review. Order:
//   1. size cap (route middleware) and parse        -> INVALID_INPUT
//   2. verify every user signature locally           -> INVALID_INPUT
//   3. rate-limit the verified signer and hashed IP  -> RATE_LIMITED
//   4. validate the allowlist on the parsed object    -> SPONSOR_REJECTED
//   5. no new sponsored ATAs for a wallet that closed sponsor-paid ones to another address
//   6. the RPC is not mainnet by its genesis hash (once per process; fails closed) -> 400/502
//   7. sign that same object
//   8. reserve the worst-case lamports under the daily cap (atomic) -> RATE_LIMITED; the same
//      signature already reserved is the same transaction again: answer it, send nothing
//   9. simulate with sigVerify; release on failure   -> SLIPPAGE_EXCEEDED, ... PROGRAM_ERROR
//  10. take the daily ATA budget (wallet and hashed IP); release if it is used up
//  11. send with skipPreflight and return the signature at once. A send error may come after
//      the node took the transaction, so the reservation and the ATA budget stay spent and the
//      502 names the signature to look up.
// No step before 9 calls the RPC (apart from the genesis check and one rent read, both made
// once), and nothing from an exception reaches the client, or the logs beyond `errorSummary`.

import { Buffer } from 'node:buffer'
import {
  atasClosedAway,
  listMarketMints,
  rateLimitTake,
  sponsorRelease,
  sponsorReserve,
} from '@horagon/db'
import { assertNotMainnetGenesis, errorSummary, fromProgramError, PROTOCOL_DAO } from '@horagon/sdk'
import { ComputeBudgetProgram, PublicKey, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { RPC_DOWN_HINT, rpc } from '../chain'
import type { ApiDeps, SponsorConfig } from '../deps'
import { ApiError } from '../problem'
import { DEFAULT_SPONSOR_LIMITS, type SponsorPolicy, type SponsorVerdict } from './policy'
import { validateSponsoredTransaction } from './validate'

const LAMPORTS_PER_SIGNATURE = 5_000n
/** Rent-exempt minimum of a 165-byte SPL token account; read once from the RPC, then kept. */
let tokenAccountRent: bigint | undefined
/** Connections whose genesis hash was read and is not mainnet's. A failed check is not kept. */
const notMainnet = new WeakSet<object>()

/**
 * Spec 19.1, failing closed: the sponsor signs nothing until the RPC has shown, by its genesis
 * hash, that it is not mainnet (MAINNET_DISABLED, 400). An RPC error here is NETWORK (502).
 */
async function assertNotMainnetRpc(deps: ApiDeps): Promise<void> {
  if (notMainnet.has(deps.connection)) return
  await rpc('getGenesisHash', () => assertNotMainnetGenesis(deps.connection))
  notMainnet.add(deps.connection)
}

export function parseTransaction(base64: string): VersionedTransaction {
  try {
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length === 0 || bytes.length > 1_232) throw new Error('size')
    return VersionedTransaction.deserialize(bytes)
  } catch {
    throw new ApiError('INVALID_INPUT', 'tx is not a serialized v0 or legacy transaction')
  }
}

/** Ed25519 check of every signature except the fee payer's (still empty), via WebCrypto. */
export async function verifyUserSignatures(tx: VersionedTransaction): Promise<PublicKey[]> {
  const message = tx.message.serialize()
  const n = tx.message.header.numRequiredSignatures
  const keys = tx.message.staticAccountKeys
  const signers: PublicKey[] = []
  for (let i = 1; i < n; i++) {
    const key = keys[i]
    const sig = tx.signatures[i]
    if (!key || !sig || sig.every((b) => b === 0)) {
      throw new ApiError('INVALID_INPUT', `signature ${i} is missing`)
    }
    const pub = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(key.toBytes()),
      { name: 'Ed25519' },
      false,
      ['verify'],
    )
    const ok = await crypto.subtle.verify(
      { name: 'Ed25519' },
      pub,
      new Uint8Array(sig),
      new Uint8Array(message),
    )
    if (!ok) throw new ApiError('INVALID_INPUT', `signature ${i} does not verify`)
    signers.push(key)
  }
  if (signers.length === 0) throw new ApiError('INVALID_INPUT', 'no user signature')
  return signers
}

/**
 * Worst case the sponsor pays for `tx`: base fee per signature, the priority fee at the
 * requested CU limit, and full rent for each of the `ataCreates` the validator approved (an
 * existing ATA costs nothing, but the reservation must not depend on an RPC read). Rent is
 * spend, not float: the user owns the ATA and may close it to themselves.
 */
export function exposureLamports(
  tx: VersionedTransaction,
  rentPerAta: bigint,
  ataCreates: number,
): bigint {
  const keys = tx.message.staticAccountKeys
  let cuLimit = 200_000n
  let microLamports = 0n
  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex]
    if (!program) continue
    if (program.equals(ComputeBudgetProgram.programId)) {
      const data = Buffer.from(ix.data)
      if (data[0] === 2 && data.length >= 5) cuLimit = BigInt(data.readUInt32LE(1))
      if (data[0] === 3 && data.length >= 9) microLamports = data.readBigUInt64LE(1)
    }
  }
  const priority = (cuLimit * microLamports + 999_999n) / 1_000_000n
  return (
    LAMPORTS_PER_SIGNATURE * BigInt(tx.message.header.numRequiredSignatures) +
    priority +
    BigInt(ataCreates) * rentPerAta
  )
}

/** Horagon market pubkeys and mints, preloaded because the validator's callbacks are sync. */
export class MarketSet {
  private markets = new Set<string>()
  /** YES or NO mint -> its market. */
  private mints = new Map<string, string>()
  private loadedAt = 0

  constructor(
    private readonly deps: Pick<ApiDeps, 'db'>,
    private readonly ttlMs = 30_000,
  ) {}

  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.loadedAt < this.ttlMs) return
    const rows = await listMarketMints(this.deps.db)
    this.markets = new Set(rows.map((r) => r.pubkey))
    this.mints = new Map(
      rows.flatMap(
        (r): Array<[string, string]> => [
          [r.yesMint, r.pubkey],
          [r.noMint, r.pubkey],
        ],
      ),
    )
    this.loadedAt = Date.now()
  }

  hasMarket(k: PublicKey): boolean {
    return this.markets.has(k.toBase58())
  }

  /** The market a YES or NO mint belongs to. */
  marketOfMint(k: PublicKey): PublicKey | undefined {
    const market = this.mints.get(k.toBase58())
    return market === undefined ? undefined : new PublicKey(market)
  }
}

export async function hashIp(ip: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${ip}`))
  return Buffer.from(digest).toString('hex')
}

export interface SubmitInput {
  tx: string
  ip: string
}

export async function submitSponsored(
  deps: ApiDeps,
  marketSet: MarketSet,
  input: SubmitInput,
): Promise<{ signature: string }> {
  const sponsor = deps.sponsor
  if (!sponsor)
    throw new ApiError('SPONSOR_REJECTED', 'The sponsor is not configured', { reason: 'DISABLED' })
  const tx = parseTransaction(input.tx)
  const [user] = await verifyUserSignatures(tx)
  if (!user) throw new ApiError('INVALID_INPUT', 'no user signature')
  const wallet = user.toBase58()
  const ipHash = await hashIp(input.ip, deps.ipSalt)
  const perHour = sponsor.txPerHour
  for (const key of [`sponsor:w:${wallet}`, `sponsor:ip:${ipHash}`]) {
    const wait = await rateLimitTake(deps.db, key, {
      capacity: perHour,
      refillPerSec: perHour / 3600,
    })
    if (wait > 0) {
      throw new ApiError('RATE_LIMITED', `Sponsor limit: ${perHour} transactions an hour`, {
        retryAfterSecs: wait,
      })
    }
  }

  await marketSet.refresh()
  let verdict = checkSponsored(deps, tx, marketSet)
  if (!verdict.ok && (verdict.reason === 'PM_AMM_RULE' || verdict.reason === 'ATA_RULE')) {
    // A market created seconds ago may be missing from the cached set.
    await marketSet.refresh(true)
    verdict = checkSponsored(deps, tx, marketSet)
  }
  if (!verdict.ok) {
    throw new ApiError('SPONSOR_REJECTED', verdict.detail, { reason: verdict.reason })
  }
  const { ataCreates } = verdict
  if (
    ataCreates > 0 &&
    (await atasClosedAway(deps.db, wallet, sponsor.keypair.publicKey.toBase58())) > 0
  ) {
    throw new ApiError(
      'SPONSOR_REJECTED',
      'This wallet closed sponsor-paid token accounts to another address',
      {
        reason: 'ATA_CLOSED_AWAY',
        hint: 'The sponsor no longer opens token accounts for it. Trades in markets where it already holds YES and NO accounts still work.',
      },
    )
  }

  await assertNotMainnetRpc(deps)
  tx.sign([sponsor.keypair])
  const first = tx.signatures[0]
  if (!first) throw new ApiError('INVALID_INPUT', 'no fee payer signature slot')
  const signature = bs58.encode(first)

  if (tokenAccountRent === undefined) {
    const rent = await rpc('getMinimumBalanceForRentExemption', () =>
      deps.connection.getMinimumBalanceForRentExemption(165),
    )
    tokenAccountRent = BigInt(rent)
  }
  const reservation = await sponsorReserve(deps.db, {
    sig: signature,
    wallet,
    ipHash,
    lamports: exposureLamports(tx, tokenAccountRent, ataCreates),
    capLamports: sponsor.dailyCapLamports,
  })
  if (reservation === 'duplicate') {
    // The sponsor's signature is deterministic: this exact transaction was submitted before.
    deps.log.info({ sig: signature, wallet }, 'sponsored tx already submitted')
    return { signature }
  }
  if (reservation === 'over_cap') {
    throw new ApiError('RATE_LIMITED', "Today's sponsor budget is used up", {
      hint: 'Retry after 00:00 UTC, or build the transaction with sponsored: false and pay the fee.',
      retryAfterSecs: secondsToUtcMidnight(deps.now()),
    })
  }

  try {
    const sim = await deps.connection.simulateTransaction(tx, {
      sigVerify: true,
      commitment: 'confirmed',
    })
    if (sim.value.err) {
      const err = fromProgramError({ err: sim.value.err, logs: sim.value.logs ?? [] })
      throw new ApiError(err.code, err.message, {
        hint: err.hint,
        ...(err.programCode === undefined ? {} : { programCode: err.programCode }),
      })
    }
    if (ataCreates > 0) await takeAtaBudget(deps.db, sponsor, wallet, ipHash, ataCreates)
  } catch (e) {
    // Nothing was sent: the reservation goes back.
    await sponsorRelease(deps.db, signature)
    if (e instanceof ApiError) throw e
    deps.log.warn({ error: errorSummary(e), sig: signature }, 'sponsor simulate failed')
    throw new ApiError('NETWORK', 'Could not reach the Solana RPC; nothing was sent', {
      status: 502,
      hint: RPC_DOWN_HINT,
    })
  }
  try {
    await deps.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 })
  } catch (e) {
    // The node may have taken it before the error: keep the reservation and the ATA budget.
    deps.log.warn({ error: errorSummary(e), sig: signature }, 'sponsor send failed')
    throw new ApiError('NETWORK', 'The RPC did not confirm it received the transaction', {
      status: 502,
      signature,
      hint: `It may still land. Check GET /api/v1/tx/${signature} before building a new trade.`,
    })
  }
  deps.log.info({ sig: signature, wallet }, 'sponsored tx sent')
  return { signature }
}

/** Each new ATA costs its rent for good, so a wallet and an IP get a daily number of them. */
async function takeAtaBudget(
  db: ApiDeps['db'],
  sponsor: SponsorConfig,
  wallet: string,
  ipHash: string,
  creates: number,
): Promise<void> {
  const buckets: Array<[string, number]> = [
    [`ata:w:${wallet}`, sponsor.atasPerDay.wallet],
    [`ata:ip:${ipHash}`, sponsor.atasPerDay.ip],
  ]
  for (const [key, capacity] of buckets) {
    const wait =
      creates > capacity
        ? 86_400
        : await rateLimitTake(db, key, { cost: creates, capacity, refillPerSec: capacity / 86_400 })
    if (wait > 0) {
      throw new ApiError('RATE_LIMITED', `Sponsor limit: ${capacity} new token accounts a day`, {
        hint: 'Trade in a market where you already hold YES and NO, or come back later.',
        retryAfterSecs: wait,
      })
    }
  }
}

/** The validator; a policy callback that throws is a server fault, answered without detail. */
function checkSponsored(deps: ApiDeps, tx: VersionedTransaction, set: MarketSet): SponsorVerdict {
  const policy = policyFor(deps, set)
  try {
    return validateSponsoredTransaction(tx, policy)
  } catch (e) {
    deps.log.error({ error: errorSummary(e) }, 'sponsor policy failed')
    throw new ApiError('SPONSOR_REJECTED', 'The sponsor could not check this transaction', {
      status: 503,
      reason: 'POLICY_ERROR',
    })
  }
}

function policyFor(deps: ApiDeps, set: MarketSet): SponsorPolicy {
  const sponsor = deps.sponsor?.keypair.publicKey
  if (!sponsor) throw new ApiError('SPONSOR_REJECTED', 'The sponsor is not configured')
  return {
    sponsor,
    collateralMint: deps.collateralMint,
    feeOwners: [PROTOCOL_DAO, deps.program.authority],
    isHoragonMarket: (k) => set.hasMarket(k),
    outcomeMintMarket: (k) => set.marketOfMint(k),
    limits: DEFAULT_SPONSOR_LIMITS,
  }
}

function secondsToUtcMidnight(nowSecs: number): number {
  return 86_400 - (nowSecs % 86_400)
}
