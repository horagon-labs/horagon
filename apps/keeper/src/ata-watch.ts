// Watches the token accounts whose rent the sponsor paid (spec 9, Tier 0 final review). The user
// owns each one and can close it to any address, so the rent is spend, not float. A close whose
// rent went anywhere but the sponsor is recorded and alerted, and the API then opens no more
// accounts for that wallet (`atasClosedAway`). One close is expected: pm-AMM's claim_winnings
// closes the user's YES and NO itself, rent to the user, once the market is resolved. Its reads
// share the indexer's IndexPace: a pause holds them, and a rate limit here pauses both.
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
import { type IndexPace, isRateLimited } from './index-pace'

/** SPL Token `CloseAccount`: accounts [account, destination, owner]. */
const CLOSE_ACCOUNT = 9
/** An ATA younger than this is not closed on one empty read: a lagging node may not see it yet. */
const MIN_AGE_SECS = 600
const MAX_BATCH = 100
/** Signatures asked for per page of an address's history (the RPC maximum). */
const PAGE = 1000
/**
 * What one pass may spend. Cheap transactions that name an address can bury its close under any
 * number of signatures, so a pass is bounded by calls and by wall time, and a trace that runs out
 * resumes on the next pass (see `TraceState`). One place to tune; tests pass their own.
 */
export const PASS_BUDGET = { txCalls: 200, ms: 20_000 }
/** Consecutive passes that cut a trace off before ops is told (6 passes of 10 min: an hour). */
export const CUT_ALERT_AFTER = 6

/** Where a trace of one ATA's close stopped, kept in memory; a restart starts it over. */
export interface TraceState {
  /** The oldest signature already read: the next pass pages back from it. */
  before?: string
  /** Consecutive passes that ran out of budget on this ATA. */
  cuts: number
  alerted: boolean
}
const defaultTraces = new Map<string, TraceState>()
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
  /** Per-pass spend; defaults to PASS_BUDGET. */
  budget?: { txCalls: number; ms: number }
  /** Wall clock in ms for the time budget; defaults to Date.now. */
  clock?: () => number
  /** Trace cursors per ATA creation; defaults to a module-level map. */
  traces?: Map<string, TraceState>
  /** The indexer's read pace (`main.ts`): its pause holds this pass too. */
  pace?: Pick<IndexPace, 'held' | 'rateLimited' | 'clean' | 'spaceSignatures'>
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

type Found = ({ sig: string | null } & AtaClose) | 'cut'

/** Spent so far in this pass. */
interface Spent {
  txCalls: number
  startedAt: number
}

/**
 * Newest first, paged back with `before` until the close, the creation (nothing older can close
 * it) or an empty page. There is no cap on how far back it reads: noise only makes it slower.
 * When the pass budget runs out first, it returns 'cut' with its place saved in `state`.
 */
async function findClose(
  deps: AtaWatchDeps,
  ata: string,
  createdSig: string,
  state: TraceState,
  spent: Spent,
): Promise<Found> {
  const budget = deps.budget ?? PASS_BUDGET
  const clock = deps.clock ?? Date.now
  const over = () => spent.txCalls >= budget.txCalls || clock() - spent.startedAt >= budget.ms
  for (;;) {
    if (over()) return 'cut'
    await deps.pace?.spaceSignatures()
    const sigs = await deps.connection.getSignaturesForAddress(
      new PublicKey(ata),
      { limit: PAGE, until: createdSig, ...(state.before ? { before: state.before } : {}) },
      'confirmed',
    )
    if (sigs.length === 0) return { sig: null, to: 'unknown', byClaim: false }
    for (const s of sigs) {
      if (s.signature === createdSig) return { sig: null, to: 'unknown', byClaim: false }
      if (!s.err) {
        if (over()) return 'cut'
        spent.txCalls++
        const tx = await deps.connection.getTransaction(s.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        })
        const close = tx ? closeOf(tx, ata) : undefined
        if (close) return { sig: s.signature, ...close }
      }
      state.before = s.signature
    }
  }
}

/** One pass over the least recently checked open ATAs. */
export async function watchSponsoredAtas(
  deps: AtaWatchDeps,
): Promise<{ checked: number; closed: number; flagged: number }> {
  const none = { checked: 0, closed: 0, flagged: 0 }
  if (await deps.pace?.held('ata-watch')) return none
  const batch = Math.min(Math.max(Math.trunc(deps.batch ?? MAX_BATCH), 1), MAX_BATCH)
  const rows = await sponsoredAtasToCheck(deps.db, batch)
  if (rows.length === 0) return none
  const nowSecs = deps.now()
  const now = new Date(nowSecs * 1000)
  const sponsor = deps.sponsor.toBase58()
  let infos: Awaited<ReturnType<AtaWatchDeps['connection']['getMultipleAccountsInfo']>>
  try {
    infos = await deps.connection.getMultipleAccountsInfo(
      rows.map((r) => new PublicKey(r.ata)),
      'confirmed',
    )
  } catch (err) {
    if (!isRateLimited(err)) throw err
    await rateLimited(deps, undefined, err)
    return none
  }
  const traces = deps.traces ?? defaultTraces
  const spent: Spent = { txCalls: 0, startedAt: (deps.clock ?? Date.now)() }
  const stillOpen: string[] = []
  let closed = 0
  let flagged = 0
  let limited = false
  for (const [i, row] of rows.entries()) {
    // Present, too young to judge, or not traceable this pass: stays open, checked again later.
    if (infos[i] || nowSecs - row.createdAt.getTime() / 1000 < MIN_AGE_SECS) {
      stillOpen.push(row.ata)
      continue
    }
    const traceKey = `${row.ata}:${row.createdSig}`
    const state = traces.get(traceKey) ?? { cuts: 0, alerted: false }
    traces.set(traceKey, state)
    let found: Found
    try {
      found = await findClose(deps, row.ata, row.createdSig, state, spent)
    } catch (err) {
      if (isRateLimited(err)) {
        // The pass stops here; this row and the ones after it stay first in line.
        limited = true
        await rateLimited(deps, row.ata, err)
        break
      }
      deps.log.warn({ ata: row.ata, error: errorSummary(err).message }, 'ata close lookup failed')
      stillOpen.push(row.ata)
      continue
    }
    if (found === 'cut') {
      // Out of budget: not resolved, so neither closed nor flagged; the next pass resumes.
      stillOpen.push(row.ata)
      state.cuts++
      if (state.cuts >= CUT_ALERT_AFTER && !state.alerted) {
        state.alerted = true
        deps.log.warn(
          { wallet: row.wallet, ata: row.ata, passes: state.cuts },
          'sponsor-paid ATA close still being traced',
        )
        await deps.alerts.send(
          `ata-trace:${row.ata}`,
          `The close of sponsor-paid ATA ${row.ata} (wallet ${row.wallet}) is still being traced after ${state.cuts} passes: heavy transaction noise on the account. The wallet is not flagged`,
        )
      }
      continue
    }
    state.cuts = 0
    traces.delete(traceKey)
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
  if (!limited) deps.pace?.clean()
  return { checked: rows.length, closed, flagged }
}

/** A read was rate-limited: the pace pauses every index read, or the pass just stops. */
async function rateLimited(deps: AtaWatchDeps, ata: string | undefined, err: unknown) {
  if (deps.pace) await deps.pace.rateLimited('ata-watch', err)
  else {
    deps.log.warn(
      { ...(ata ? { ata } : {}), error: errorSummary(err).message },
      'ata watch reads rate-limited; pass stopped',
    )
  }
}
