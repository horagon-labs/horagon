// Watches the token accounts whose rent the sponsor paid (spec 9, Tier 0 final review). The user
// owns each one and can close it to any address, so the rent is spend, not float. A close whose
// rent went anywhere but the sponsor is recorded and alerted, and the API then opens no more
// accounts for that wallet (`atasClosedAway`). One close is expected: pm-AMM's claim_winnings
// closes the user's YES and NO itself, rent to the user, once the market is resolved.
import {
  CLAIM_CLOSE,
  type Db,
  markAtaClosed,
  markAtasChecked,
  sponsoredAtasToCheck,
} from '@horagon/db'
import {
  ataAddress,
  deriveNoMint,
  deriveYesMint,
  errorSummary,
  PM_AMM_PROGRAM_ID,
  pmAmmInstructionName,
} from '@horagon/sdk'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { type Connection, PublicKey, type VersionedTransactionResponse } from '@solana/web3.js'
import type { Logger } from 'pino'
import type { Alerter } from './alerts'
import { base58Decode } from './base58'

/** SPL Token `CloseAccount`: accounts [account, destination, owner]. */
const CLOSE_ACCOUNT = 9
/** An ATA younger than this is not closed on one empty read: a lagging node may not see it yet. */
const MIN_AGE_SECS = 600
const MAX_BATCH = 100
/** Signatures of one address read per trace, in total across pages. */
const MAX_SIGNATURES = 1000
const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]

export interface AtaWatchDeps {
  db: Db
  connection: Pick<
    Connection,
    'getMultipleAccountsInfo' | 'getSignaturesForAddress' | 'getTransaction'
  >
  sponsor: PublicKey
  alerts: Alerter
  log: Logger
  now: () => number
  /** ATAs checked per pass (one getMultipleAccountsInfo call). */
  batch?: number
}

export interface AtaClose {
  /** Who received the rent. */
  to: string
  /**
   * Closed by pm-AMM inside a top-level claim_winnings. pm-AMM runs it only on a resolved market
   * and then closes the user's YES and NO accounts, rent to the user: the end of a market the
   * user traded, not a rent grab.
   */
  byClaim: boolean
}

/**
 * Whether `ix` is a pm-AMM claim_winnings of the user whose YES or NO account is `ata`. The
 * account order is pm-AMM's: user (signer), market, collateral mint, ... A close counts as a
 * claim's only when it closes one of the accounts the claim itself would close.
 */
function isClaimOf(
  ix: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array },
  keys: { get(i: number): PublicKey | undefined },
  ata: string,
): boolean {
  if (!keys.get(ix.programIdIndex)?.equals(PM_AMM_PROGRAM_ID)) return false
  if (pmAmmInstructionName(ix.data) !== 'claimWinnings') return false
  const user = keys.get(ix.accountKeyIndexes[0] ?? -1)
  const market = keys.get(ix.accountKeyIndexes[1] ?? -1)
  if (!user || !market) return false
  return [deriveYesMint(market), deriveNoMint(market)].some(
    (m) => ataAddress({ owner: user, mint: m }).toBase58() === ata,
  )
}

/**
 * How `tx` closed `ata`: a top-level CloseAccount, or one inside another instruction (pm-AMM's
 * claim_winnings closes YES and NO that way). Undefined when it did not close it.
 */
export function closeOf(tx: VersionedTransactionResponse, ata: string): AtaClose | undefined {
  const msg = tx.transaction.message
  const keys = msg.getAccountKeys({
    ...(tx.meta?.loadedAddresses ? { accountKeysFromLookups: tx.meta.loadedAddresses } : {}),
  })
  // Data is decoded only for a token program's instruction.
  const destination = (
    programIndex: number,
    accounts: readonly number[],
    data: () => Uint8Array,
  ) => {
    const program = keys.get(programIndex)?.toBase58()
    if (!program || !TOKEN_PROGRAMS.includes(program) || data()[0] !== CLOSE_ACCOUNT) return
    const [account, to] = accounts.map((i) => keys.get(i)?.toBase58())
    return account === ata ? to : undefined
  }
  for (const ix of msg.compiledInstructions) {
    const to = destination(ix.programIdIndex, ix.accountKeyIndexes, () => ix.data)
    if (to) return { to, byClaim: false }
  }
  for (const inner of tx.meta?.innerInstructions ?? []) {
    const parent = msg.compiledInstructions[inner.index]
    for (const ix of inner.instructions) {
      const to = destination(ix.programIdIndex, ix.accounts, () => base58Decode(ix.data))
      if (to) return { to, byClaim: parent !== undefined && isClaimOf(parent, keys, ata) }
    }
  }
  return undefined
}

async function findClose(
  deps: AtaWatchDeps,
  ata: string,
  createdSig: string,
): Promise<{ sig: string | null } & AtaClose> {
  // Newest first, paged back with `before` until the creation (nothing older can close it) or
  // MAX_SIGNATURES in all: a bare window of the latest few would let anyone push a real claim out
  // of it with cheap transactions that name the address.
  let read = 0
  let before: string | undefined
  while (read < MAX_SIGNATURES) {
    const sigs = await deps.connection.getSignaturesForAddress(
      new PublicKey(ata),
      {
        limit: MAX_SIGNATURES - read,
        until: createdSig,
        ...(before ? { before } : {}),
      },
      'confirmed',
    )
    if (sigs.length === 0) return { sig: null, to: 'unknown', byClaim: false }
    for (const s of sigs) {
      if (s.signature === createdSig) return { sig: null, to: 'unknown', byClaim: false }
      read++
      if (s.err) continue
      const tx = await deps.connection.getTransaction(s.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
      const close = tx ? closeOf(tx, ata) : undefined
      if (close) return { sig: s.signature, ...close }
    }
    before = sigs.at(-1)?.signature
  }
  deps.log.warn(
    { ata, signatures: read },
    'sponsor-paid ATA close not found within the signature cap; recorded as unknown',
  )
  return { sig: null, to: 'unknown', byClaim: false }
}

/** One pass over the least recently checked open ATAs. */
export async function watchSponsoredAtas(
  deps: AtaWatchDeps,
): Promise<{ checked: number; closed: number; flagged: number }> {
  const batch = Math.min(Math.max(Math.trunc(deps.batch ?? MAX_BATCH), 1), MAX_BATCH)
  const rows = await sponsoredAtasToCheck(deps.db, batch)
  if (rows.length === 0) return { checked: 0, closed: 0, flagged: 0 }
  const nowSecs = deps.now()
  const now = new Date(nowSecs * 1000)
  const sponsor = deps.sponsor.toBase58()
  const infos = await deps.connection.getMultipleAccountsInfo(
    rows.map((r) => new PublicKey(r.ata)),
    'confirmed',
  )
  const stillOpen: string[] = []
  let closed = 0
  let flagged = 0
  for (const [i, row] of rows.entries()) {
    // Present, too young to judge, or not traceable this pass: stays open, checked again later.
    if (infos[i] || nowSecs - row.createdAt.getTime() / 1000 < MIN_AGE_SECS) {
      stillOpen.push(row.ata)
      continue
    }
    let found: { sig: string | null } & AtaClose
    try {
      found = await findClose(deps, row.ata, row.createdSig)
    } catch (err) {
      deps.log.warn({ ata: row.ata, error: errorSummary(err).message }, 'ata close lookup failed')
      stillOpen.push(row.ata)
      continue
    }
    const { sig, to, byClaim } = found
    // A claim's close is expected: the sponsor counted this rent as spent when it opened the
    // account, so the wallet owes nothing. It is recorded as 'claim' (the rent always went to the
    // claim's signer), which `atasClosedAway` does not count; `closed_sig` names the claim.
    // Guarded by the creation we traced: a newer creation of this address stays open.
    await markAtaClosed(deps.db, row.ata, {
      closedSig: sig,
      closedAt: now,
      closedTo: byClaim ? CLAIM_CLOSE : to,
      createdSig: row.createdSig,
    })
    closed++
    if (byClaim) {
      deps.log.info(
        { wallet: row.wallet, ata: row.ata, to, sig },
        'sponsor-paid ATA closed by a claim',
      )
      continue
    }
    if (to === sponsor) continue
    flagged++
    deps.log.warn({ wallet: row.wallet, ata: row.ata, to }, 'sponsor-paid ATA closed elsewhere')
    await deps.alerts.send(
      `ata-close:${row.wallet}`,
      `Wallet ${row.wallet} closed sponsor-paid ATA ${row.ata}, rent to ${to}; the sponsor opens no more accounts for it`,
    )
  }
  await markAtasChecked(deps.db, stillOpen, now)
  return { checked: rows.length, closed, flagged }
}
