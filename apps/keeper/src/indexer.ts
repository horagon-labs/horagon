// Indexer (spec 8): every 5 s, new signatures of each market not recycled (or recycled less
// than a day ago), decoded into trades and redeems/claims from token balance deltas, plus one
// price point per open market. Only top-level pm-AMM instructions are user activity; the same
// instructions inside a Horagon transaction are the keeper's own CPIs. Token accounts that a
// sponsored transaction created for its user are recorded for `ata-watch.ts`. With IndexReads
// (`index-reads.ts`, the keeper's), one account read per 100 accounts drives the pass: a
// market's signatures are read only when its account or mints changed or its sweep is due, every
// read is paced and fails over to the next RPC, and when every RPC is paused the pass stops and
// the next ones are held.
import { createHash } from 'node:crypto'
import {
  type Db,
  insertClaims,
  insertPricePoint,
  insertTrades,
  latestTradeSlots,
  listIndexableMarkets,
  type MarketRow,
  recordSponsoredAtas,
  updateMarket,
} from '@horagon/db'
import {
  decodeMarketAccount,
  errorSummary,
  isBotMemoInstruction,
  liveMarket,
  PM_AMM_PROGRAM_ID,
  PROTOCOL_DAO,
  pmAmmInstructionName,
  SWAP_DIRECTIONS,
} from '@horagon/sdk'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  type Connection,
  PublicKey,
  type TokenBalance,
  type VersionedTransactionResponse,
} from '@solana/web3.js'
import type { Logger } from 'pino'
import type { Alerter } from './alerts'
import { base58Decode } from './base58'
import { isRateLimited, PASS_BUDGET_MS, SWEEP_SECS, TRANSACTION_CHUNK } from './index-pace'
import {
  directPass,
  EveryEndpointDown,
  type IndexPass,
  type IndexReads,
  NOT_NOW,
} from './index-reads'

type TradeInsert = Parameters<typeof insertTrades>[1][number] & { botMemo: boolean }
type ClaimInsert = Parameters<typeof insertClaims>[1][number]

export interface Decoded {
  trades: TradeInsert[]
  claims: ClaimInsert[]
  /** Someone other than the Authority deposited liquidity (spec 8: flagged, not blocked). */
  externalLp: boolean
  /** The user's token accounts this transaction created with the sponsor's rent. */
  sponsoredAtas: Array<{ ata: string; wallet: string; mint: string }>
}

interface Ctx {
  market: MarketRow
  collateralMint: string
  authority: string
  /** The sponsor's pubkey; without it no ATA is recorded. */
  sponsor?: string
  /** Where a row skipped for unreadable token flows is reported. */
  log?: Logger
  /** Called for each row skipped for unreadable token flows, so it can be alerted. */
  onSkip?: (sig: string, ixIndex: number) => void
}

const TOKEN_PROGRAMS = new Set([TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()])
/**
 * Signed token movements (by account index) of the SPL Token CPIs inside one instruction.
 * Undefined when a CPI names a program or account past the static keys (a lookup-table key):
 * it cannot be read here, so the flows are never guessed.
 */
function tokenMoves(
  inner: {
    instructions: ReadonlyArray<{ programIdIndex: number; accounts: number[]; data: string }>
  },
  keys: readonly string[],
): Array<{ account: number; delta: bigint }> | undefined {
  const moves: Array<{ account: number; delta: bigint }> = []
  for (const ix of inner.instructions) {
    if (ix.programIdIndex >= keys.length || ix.accounts.some((i) => i >= keys.length)) {
      return undefined
    }
    const program = keys[ix.programIdIndex]
    if (!program || !TOKEN_PROGRAMS.has(program)) continue
    const data = base58Decode(ix.data)
    if (data.length < 9) continue
    const amount = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(1, true)
    const a = ix.accounts
    const push = (account: number | undefined, delta: bigint) => {
      if (account !== undefined) moves.push({ account, delta })
    }
    switch (data[0]) {
      case 3: // Transfer: source, destination, authority
        push(a[0], -amount)
        push(a[1], amount)
        break
      case 12: // TransferChecked: source, mint, destination, authority
        push(a[0], -amount)
        push(a[2], amount)
        break
      case 7: // MintTo: mint, destination, authority
      case 14:
        push(a[1], amount)
        break
      case 8: // Burn: account, mint, authority
      case 15:
        push(a[0], -amount)
        break
    }
  }
  return moves
}

interface Flows {
  usdc: bigint
  yes: bigint
  no: bigint
  fee: bigint
}

/** Whole-transaction balance deltas: exact when the transaction holds one pm-AMM instruction. */
export function wholeTxFlows(tx: VersionedTransactionResponse, user: string, ctx: Ctx): Flows {
  const fee =
    deltas(tx, PROTOCOL_DAO.toBase58(), ctx.collateralMint) +
    deltas(tx, ctx.authority, ctx.collateralMint)
  return {
    usdc: deltas(tx, user, ctx.collateralMint),
    yes: deltas(tx, user, ctx.market.yesMint),
    no: deltas(tx, user, ctx.market.noMint),
    fee: fee > 0n ? fee : 0n,
  }
}

/**
 * Whether a claim_winnings' flows add up. pm-AMM pays one collateral unit per winning share (the
 * IDL: "pay winning side at 1 USDC each"; no rounding, so the match is exact in raw units) and
 * burns every share the user holds, so the payout is the winning side's burn and the losing
 * side never grows. The market's outcome names the winning side; a row synced before it is
 * known gives the sides the flows allow: either one fits.
 */
export function claimAddsUp(f: Flows, outcome: string | null | undefined): boolean {
  const fits = (won: bigint, lost: bigint) => f.usdc === -won && lost <= 0n
  if (outcome === 'yes') return fits(f.yes, f.no)
  if (outcome === 'no') return fits(f.no, f.yes)
  return fits(f.yes, f.no) || fits(f.no, f.yes)
}

/** A redeem_pair burns equal YES and NO and pays the same amount of collateral. */
export function redeemAddsUp(f: Flows): boolean {
  return f.usdc === -f.yes && f.usdc === -f.no
}

/** One instruction's flows from its inner token CPIs; undefined when they were not recorded. */
function instructionFlows(
  tx: VersionedTransactionResponse,
  keys: readonly string[],
  ixIndex: number,
  user: string,
  ctx: Ctx,
): Flows | undefined {
  const meta = tx.meta
  const inner = meta?.innerInstructions?.find((i) => i.index === ixIndex)
  if (!meta || !inner) return undefined
  const owners = new Map<number, { owner?: string; mint: string }>()
  for (const b of [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])]) {
    owners.set(b.accountIndex, { ...(b.owner ? { owner: b.owner } : {}), mint: b.mint })
  }
  const moves = tokenMoves(inner, keys)
  if (!moves) return undefined
  const net = (owner: string, mint: string) =>
    moves
      .filter((x) => {
        const o = owners.get(x.account)
        return o?.owner === owner && o.mint === mint
      })
      .reduce((n, x) => n + x.delta, 0n)
  const feeIn = (owner: string) => {
    const n = net(owner, ctx.collateralMint)
    return n > 0n ? n : 0n
  }
  return {
    usdc: net(user, ctx.collateralMint),
    yes: net(user, ctx.market.yesMint),
    no: net(user, ctx.market.noMint),
    fee: feeIn(PROTOCOL_DAO.toBase58()) + feeIn(ctx.authority),
  }
}

function held(list: TokenBalance[] | null | undefined, owner: string, mint: string): bigint {
  return (list ?? [])
    .filter((b) => b.owner === owner && b.mint === mint)
    .reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n)
}

/** Change in what `owner` holds of `mint` across the transaction. */
function deltas(tx: VersionedTransactionResponse, owner: string, mint: string): bigint {
  return (
    held(tx.meta?.postTokenBalances, owner, mint) - held(tx.meta?.preTokenBalances, owner, mint)
  )
}

/**
 * Pairs a getTransactions batch with the signatures asked for. JSON-RPC 2.0 lets a node answer a
 * batch in any order, devnet does (measured 2026-11-26: ids 0,2,1 and 2,1,0), and web3.js keeps
 * the order it received. So each signature gets the response whose first signature (the
 * transaction id) is it, or null: a missing, short or foreign answer reads as not available.
 */
export function inRequestOrder<T extends { transaction: { signatures: string[] } }>(
  sigs: readonly string[],
  txs: ReadonlyArray<T | null>,
): Array<T | null> {
  const bySig = new Map<string, T>()
  for (const tx of txs) {
    const id = tx?.transaction.signatures[0]
    if (tx && id !== undefined && !bySig.has(id)) bySig.set(id, tx)
  }
  return sigs.map((sig) => bySig.get(sig) ?? null)
}

/**
 * The transaction carries the top-level `horagon:bot` SPL Memo, with no accounts and that exact
 * data: bot rule (a) of docs/metrics.md, read the way scripts/count-fans.mjs reads it.
 */
export function hasBotMemo(tx: VersionedTransactionResponse): boolean {
  const msg = tx.transaction.message
  const keys = msg.staticAccountKeys
  return msg.compiledInstructions.some((ix) => {
    const program = keys[ix.programIdIndex]
    return (
      program !== undefined && isBotMemoInstruction(program, ix.accountKeyIndexes.length, ix.data)
    )
  })
}

/** Trades and claims of one confirmed transaction that touched `ctx.market`. */
export function decodeTransaction(
  sig: string,
  tx: VersionedTransactionResponse,
  ctx: Ctx,
): Decoded {
  const out: Decoded = { trades: [], claims: [], externalLp: false, sponsoredAtas: [] }
  if (!tx.meta || tx.meta.err) return out
  // No block time, no rows: a time made up for it would sort first in positions. `indexMarket`
  // stops before such a transaction, so this only guards other callers.
  if (tx.blockTime === null || tx.blockTime === undefined) return out
  const msg = tx.transaction.message
  const keys = msg.staticAccountKeys.map((k) => k.toBase58())
  const signers = keys.slice(0, msg.header.numRequiredSignatures)
  // With a sponsor, signer 0 pays the fee and signer 1 is the user (spec 9).
  const user = signers.length > 1 ? (signers[1] as string) : (signers[0] as string)
  const blockTime = new Date(tx.blockTime * 1000)
  const botMemo = hasBotMemo(tx)
  const slot = BigInt(tx.slot)
  const m = ctx.market
  const pmAmmCalls = msg.compiledInstructions.filter(
    (ix) => keys[ix.programIdIndex] === PM_AMM_PROGRAM_ID.toBase58(),
  ).length
  msg.compiledInstructions.forEach((ix, ixIndex) => {
    if (keys[ix.programIdIndex] !== PM_AMM_PROGRAM_ID.toBase58()) return
    if (!ix.accountKeyIndexes.some((i) => keys[i] === m.pubkey)) return
    const name = pmAmmInstructionName(ix.data)
    if (name === 'depositLiquidity') {
      if (user !== ctx.authority) out.externalLp = true
      return
    }
    if (name !== 'swap' && name !== 'redeemPair' && name !== 'claimWinnings') return
    // Several pm-AMM instructions share one transaction's balance deltas, so each reads its own
    // CPIs; a lone one may use the whole-transaction deltas. Flows that cannot be read are never
    // guessed.
    const flows =
      pmAmmCalls === 1
        ? wholeTxFlows(tx, user, ctx)
        : instructionFlows(tx, keys, ixIndex, user, ctx)
    if (!flows) {
      ctx.log?.warn({ market: m.pubkey, sig, ixIndex }, 'token flows not recorded; row skipped')
      ctx.onSkip?.(sig, ixIndex)
      return
    }
    const { usdc, yes, no, fee } = flows
    if (name === 'swap') {
      const direction = SWAP_DIRECTIONS[ix.data[8] ?? 255] ?? 'unknown'
      out.trades.push({
        sig,
        ixIndex,
        market: m.pubkey,
        wallet: user,
        direction,
        usdcAmount: usdc < 0n ? -usdc : usdc,
        usdcDelta: usdc,
        yesDelta: yes,
        noDelta: no,
        fee,
        slot,
        blockTime,
        botMemo,
      })
    } else if (name === 'redeemPair' || name === 'claimWinnings') {
      // A row is never stored from flows that cannot be right (a node that returns token balances
      // missing accounts, say): it is skipped and alerted like an unreadable one.
      if (!(name === 'redeemPair' ? redeemAddsUp(flows) : claimAddsUp(flows, m.outcome))) {
        ctx.log?.warn(
          { market: m.pubkey, sig, ixIndex, name, usdc, yes, no },
          'token flows do not add up; row skipped',
        )
        ctx.onSkip?.(sig, ixIndex)
        return
      }
      out.claims.push({
        sig,
        ixIndex,
        market: m.pubkey,
        wallet: user,
        kind: name === 'redeemPair' ? 'redeem' : 'claim',
        usdcAmount: usdc > 0n ? usdc : 0n,
        yesDelta: yes,
        noDelta: no,
        blockTime,
      })
    }
  })
  if (ctx.sponsor && keys[0] === ctx.sponsor) {
    // Created here: a token balance after the transaction and none before it.
    const before = new Set((tx.meta.preTokenBalances ?? []).map((b) => b.accountIndex))
    const after = new Set((tx.meta.postTokenBalances ?? []).map((b) => b.accountIndex))
    for (const ix of msg.compiledInstructions) {
      if (keys[ix.programIdIndex] !== ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()) continue
      const [payer, ata, owner, mint] = ix.accountKeyIndexes
      if (payer === undefined || ata === undefined || owner === undefined || mint === undefined) {
        continue
      }
      if (keys[payer] !== ctx.sponsor || keys[owner] !== user) continue
      if (before.has(ata) || !after.has(ata)) continue
      out.sponsoredAtas.push({
        ata: keys[ata] as string,
        wallet: user,
        mint: keys[mint] as string,
      })
    }
  }
  return out
}

/** Consecutive passes that stopped on the same unreadable signature, per market. */
export interface StopState {
  sig: string
  count: number
  /** When this market last warned; kept across signature changes. */
  warnedAt: number
  /** @deprecated Never read; the alerter dedupes repeats. Kept optional for type compatibility. */
  alerted?: boolean
}

/** Consecutive stops (about 5 minutes at the 5 s loop) before `index-stuck` is sent. */
export const STUCK_AFTER = 60
const WARN_EVERY_SECS = 60
const defaultStops = new Map<string, StopState>()

export interface IndexerDeps {
  db: Db
  /** Without `reads`: every read straight on this connection, every market every pass. */
  connection?: Connection
  collateralMint: PublicKey
  authority: PublicKey
  alerts: Alerter
  log: Logger
  now: () => number
  /** The sponsor; when set, the ATAs it paid for are recorded. */
  sponsor?: PublicKey
  /** Stop counters per market; defaults to a module-level map. */
  stops?: Map<string, StopState>
  /**
   * The keeper's index reads (`main.ts`): paced, change-driven, failing over between RPCs.
   * Without them every market is read on every pass through `connection`, unspaced, and a rate
   * limit only stops the pass.
   */
  reads?: IndexReads<Connection>
}

/** Accounts per getMultipleAccountsInfo call (the RPC maximum). */
const ACCOUNTS_PER_READ = 100
/** The stop of a market whose signature list could not be read (not a signature). */
const SIGNATURE_LIST = '(signature list)'
/**
 * The stop of a market whose signature list came from an RPC behind its cursor (not a
 * signature): the newest signature listed is older than the one the cursor was written to.
 */
const RPC_BEHIND = '(index RPC behind)'

type AccountInfos = Awaited<ReturnType<Connection['getMultipleAccountsInfo']>>

/**
 * A read of the pass was rate-limited (or every RPC was paused) after the market's progress was
 * saved: the pass stops.
 */
class RateLimitedPass extends Error {
  override name = 'RateLimitedPass'
  constructor(readonly error: unknown) {
    super('rate limited')
  }
}

/**
 * The hash of a market's account and its two outcome mints. claim_winnings and redeem_pair leave
 * the market account as it was but burn shares, so a mint's supply is what shows them.
 */
function accountsHash(infos: AccountInfos): string {
  const h = createHash('sha256')
  for (const info of infos) {
    if (!info) h.update('none;')
    else h.update(`${info.data.length}:`).update(info.data).update(';')
  }
  return h.digest('base64')
}

/**
 * One pass over the indexable markets. Returns how many rows were written; `paused` when the
 * reads were held (every RPC paused: no read at all).
 *
 * First one getMultipleAccountsInfo per 100 accounts (each market and its yes and no mints): the
 * open markets' price points and each market's hash of the three. With IndexReads, only the
 * markets due (`MarketMarks.due`: not indexed in full since start, account changed, or sweep due:
 * 60 s open, 5 min otherwise) are asked for their signatures, least recently indexed first, and
 * none is started once the pass is PASS_BUDGET_MS old. When every RPC is paused the pass stops
 * and the next ones are held; without IndexReads a rate limit only stops the pass.
 */
export async function indexOnce(
  deps: IndexerDeps,
): Promise<{ trades: number; claims: number; prices: number; paused?: true }> {
  const reads = deps.reads
  let pass: IndexPass<Connection> | null
  if (reads) pass = await reads.begin('index')
  else if (deps.connection) pass = directPass(deps.connection)
  else throw new Error('indexOnce needs reads or a connection')
  if (!pass) return { trades: 0, claims: 0, prices: 0, paused: true }
  try {
    return await indexPass(deps, pass)
  } finally {
    pass.end()
  }
}

/** A read that stops the pass: every RPC paused, or (without IndexReads) a rate limit. */
const stopsPass = (err: unknown) => err instanceof EveryEndpointDown || isRateLimited(err)

async function indexPass(
  deps: IndexerDeps,
  pass: IndexPass<Connection>,
): Promise<{ trades: number; claims: number; prices: number }> {
  const marks = deps.reads?.marks
  const clock = deps.reads?.clock
  const now = deps.now()
  const markets = await listIndexableMarkets(deps.db, new Date(now * 1000))
  let trades = 0
  let claims = 0
  let prices = 0
  const isOpen = (m: MarketRow) => m.status === 'open' && m.endTs.getTime() / 1000 > now
  // With IndexReads the endpoint's pace has logged it (and IndexReads pages when it is long).
  const stopPass = (market: string | undefined, err: unknown) => {
    if (deps.reads) return
    deps.log.warn(
      { ...(market ? { market } : {}), error: errorSummary(err).message },
      'index reads rate-limited; pass stopped',
    )
  }

  // Every market's account and mints: the open markets' prices, and what changed since the last
  // pass (a swap or liquidity change writes the market; a claim or redeem only the mints).
  const hashes = new Map<string, string>()
  if (markets.length > 0) {
    try {
      const keys = markets.flatMap((m) => [m.pubkey, m.yesMint, m.noMint])
      const infos: AccountInfos = []
      for (let i = 0; i < keys.length; i += ACCOUNTS_PER_READ) {
        const chunk = keys.slice(i, i + ACCOUNTS_PER_READ)
        const got = await pass.accounts((c) =>
          c.getMultipleAccountsInfo(
            chunk.map((k) => new PublicKey(k)),
            'confirmed',
          ),
        )
        for (const j of chunk.keys()) infos.push(got[j] ?? null)
      }
      for (const [j, m] of markets.entries()) {
        const own = infos.slice(3 * j, 3 * j + 3)
        hashes.set(m.pubkey, accountsHash(own))
        if (isOpen(m)) prices += await pricePoint(deps, m, own[0] ?? null, now)
      }
    } catch (err) {
      if (stopsPass(err)) {
        stopPass(undefined, err)
        return { trades, claims, prices }
      }
      deps.log.warn({ error: errorSummary(err).message }, 'price read failed')
    }
  }

  let due = markets
  if (marks) {
    marks.retain(new Set(markets.map((m) => m.pubkey)))
    const sweep = (m: MarketRow) => (isOpen(m) ? SWEEP_SECS.open : SWEEP_SECS.closed)
    due = markets
      .filter((m) => marks.due(m.pubkey, hashes.get(m.pubkey), sweep(m), now))
      .sort((a, b) => marks.lastIndexedAt(a.pubkey) - marks.lastIndexedAt(b.pubkey))
    // After a start no cursor slot is known yet: the slot of each market's newest trade stands in
    // (the cursor is written after its rows, so it is at or past it), one query for them all.
    const unseeded = due.filter((m) => m.indexCursor && marks.needsCursorSlot(m.pubkey))
    if (unseeded.length > 0) {
      const slots = await latestTradeSlots(
        deps.db,
        unseeded.map((m) => m.pubkey),
      )
      for (const m of unseeded) {
        const slot = slots.get(m.pubkey)
        marks.seedCursorSlot(m.pubkey, slot === undefined ? null : Number(slot))
      }
    }
  }
  const stops = deps.stops ?? defaultStops
  const startedAt = clock?.() ?? 0
  for (const [i, m] of due.entries()) {
    if (clock && i > 0 && clock() - startedAt >= PASS_BUDGET_MS) {
      deps.log.debug?.({ left: due.length - i }, 'index pass budget spent; the rest go next pass')
      break
    }
    try {
      const left = () => Math.max(0, PASS_BUDGET_MS - ((clock?.() ?? 0) - startedAt))
      const r = await indexMarket(deps, pass, m, left)
      trades += r.trades
      claims += r.claims
      if (r.partial) {
        // The transaction budget ran out: the market goes on next pass, after the markets that
        // waited longer, and nothing else is started (it would only read signatures).
        marks?.partial(m.pubkey, now)
        break
      }
      // Indexed in full unless it stopped at something it could not read.
      if (stops.has(m.pubkey)) marks?.forget(m.pubkey)
      else marks?.indexed(m.pubkey, hashes.get(m.pubkey), now)
    } catch (err) {
      marks?.forget(m.pubkey)
      if (err instanceof RateLimitedPass || stopsPass(err)) {
        stopPass(m.pubkey, err instanceof RateLimitedPass ? err.error : err)
        break
      }
      deps.log.warn({ market: m.pubkey, error: errorSummary(err).message }, 'index failed')
    }
  }
  return { trades, claims, prices }
}

/** The price point of an open market from its account; 1 when one was written. */
async function pricePoint(
  deps: IndexerDeps,
  m: MarketRow,
  info: AccountInfos[number],
  now: number,
): Promise<number> {
  if (!info) return 0
  try {
    const live = liveMarket(decodeMarketAccount(info), now)
    if (live.price === null) return 0
    await insertPricePoint(deps.db, {
      market: m.pubkey,
      ts: new Date(now * 1000),
      price: live.price,
    })
    return 1
  } catch (err) {
    deps.log.warn({ market: m.pubkey, error: errorSummary(err).message }, 'price point failed')
    return 0
  }
}

/**
 * A market stopped at `sig` (or at SIGNATURE_LIST: its signatures could not be listed; or at
 * RPC_BEHIND: they were listed by an RPC behind the cursor): warn at
 * most once a minute per market; from STUCK_AFTER stops on, send `index-stuck` on every stop.
 * The alerter's dedupe throttles it, and re-arms the key after a failed delivery, which is why
 * this must not be a one-shot.
 */
async function noteStop(deps: IndexerDeps, m: MarketRow, sig: string): Promise<void> {
  const stops = deps.stops ?? defaultStops
  const now = deps.now()
  const prev = stops.get(m.pubkey)
  const st: StopState =
    prev && prev.sig === sig ? prev : { sig, count: 0, warnedAt: prev?.warnedAt ?? -Infinity }
  st.count++
  stops.set(m.pubkey, st)
  if (now - st.warnedAt >= WARN_EVERY_SECS) {
    st.warnedAt = now
    deps.log.warn(
      { market: m.pubkey, sig, stops: st.count },
      sig === SIGNATURE_LIST
        ? 'signature list not readable; indexing waits'
        : sig === RPC_BEHIND
          ? 'index RPC behind the cursor; indexing waits'
          : 'transaction not readable yet; indexing waits',
    )
  }
  if (st.count >= STUCK_AFTER) {
    const what =
      sig === SIGNATURE_LIST
        ? `its signature list has been unreadable for ${st.count} passes`
        : sig === RPC_BEHIND
          ? `the index RPC has been behind its cursor for ${st.count} passes`
          : `signature ${sig} has been unreadable for ${st.count} passes`
    await deps.alerts.send(
      `index-stuck:${m.pubkey}`,
      `Indexing of ${m.gameId} (market ${m.pubkey}) is stuck: ${what}`,
    )
  }
}

/**
 * One market from its cursor. With IndexReads, each batch of transactions comes out of the
 * transaction budget, waited for no longer than `budgetLeft()`; when it would come later the scan
 * stops there (`partial`), the cursor at the last transaction read. A listing from an RPC behind the cursor (`MarketMarks.cursorSlot`) is not
 * read at all: the cursor never moves back.
 */
async function indexMarket(
  deps: IndexerDeps,
  pass: IndexPass<Connection>,
  m: MarketRow,
  budgetLeft: () => number = () => 0,
): Promise<{ trades: number; claims: number; partial?: true }> {
  const stops = deps.stops ?? defaultStops
  const marks = deps.reads?.marks
  const address = new PublicKey(m.pubkey)
  const sigs: string[] = []
  /** Each listed signature's slot, for the slot of the signature the cursor is written to. */
  const slots = new Map<string, number>()
  let newestFetched: string | undefined
  let before: string | undefined
  // Newest first; page back until the cursor (the newest signature already indexed). A read
  // that stops the pass (every RPC paused, a rate limit without IndexReads) is not the market's;
  // any other failure counts toward index-stuck.
  try {
    for (;;) {
      const page = await pass.signatures((c) =>
        c.getSignaturesForAddress(
          address,
          {
            limit: 1000,
            ...(before ? { before } : {}),
            ...(m.indexCursor ? { until: m.indexCursor } : {}),
          },
          'confirmed',
        ),
      )
      // An RPC that does not hold the cursor signature yet (a failover to one behind) answers
      // `until` with older signatures: nothing is read, the cursor stays, the market is asked
      // again next pass. Counted as a stop, so one that stays behind reaches index-stuck.
      const known = m.indexCursor ? marks?.cursorSlot(m.pubkey) : undefined
      const newest = page[0]?.slot
      if (!before && known !== undefined && typeof newest === 'number' && newest < known) {
        await noteStop(deps, m, RPC_BEHIND)
        return { trades: 0, claims: 0 }
      }
      for (const s of page) if (typeof s.slot === 'number') slots.set(s.signature, s.slot)
      newestFetched ??= page[0]?.signature
      sigs.push(...page.filter((s) => s.err === null).map((s) => s.signature))
      if (page.length < 1000) break
      before = page.at(-1)?.signature
    }
  } catch (err) {
    if (!stopsPass(err)) await noteStop(deps, m, SIGNATURE_LIST)
    throw err
  }
  // Nothing fetched: the market did not move past a signature, so a stall counter stays; one
  // for an unreadable signature list does not, the list was read.
  if (!newestFetched) {
    const sig = stops.get(m.pubkey)?.sig
    if (sig === SIGNATURE_LIST || sig === RPC_BEHIND) stops.delete(m.pubkey)
    return { trades: 0, claims: 0 }
  }
  const ordered = sigs.reverse()
  // The newest signature fully processed: the cursor never moves past a transaction not read.
  let processed: string | undefined
  let stoppedAt: string | undefined
  let trades = 0
  let claims = 0
  let externalLp = false
  const skipped: Array<{ sig: string; ixIndex: number }> = []
  let rateLimited: { error: unknown } | undefined
  let partial = false
  scan: for (let i = 0; i < ordered.length; i += TRANSACTION_CHUNK) {
    const chunk = ordered.slice(i, i + TRANSACTION_CHUNK)
    let answer: Array<VersionedTransactionResponse | null>
    try {
      const got = await pass.transactions(chunk.length, budgetLeft(), (c) =>
        c.getTransactions(chunk, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }),
      )
      if (got === NOT_NOW) {
        partial = true
        break
      }
      answer = got
    } catch (err) {
      if (err instanceof EveryEndpointDown) {
        // Every RPC is paused: not this market's fault, so no index-stuck count. The cursor
        // keeps what earlier chunks read, and the pass stops.
        deps.log.warn(
          { market: m.pubkey, sig: chunk[0], size: chunk.length, error: err.message },
          'transaction batch read failed',
        )
        rateLimited = { error: err }
        break
      }
      // web3.js fails the whole batch on one error entry (a rate limit, a node hiccup). Read it
      // as nothing available: the scan stops at the chunk's first signature, the cursor keeps
      // what earlier chunks read, and a market that keeps failing reaches index-stuck.
      deps.log.warn(
        { market: m.pubkey, sig: chunk[0], size: chunk.length, error: errorSummary(err).message },
        'transaction batch read failed',
      )
      // A rate limit also stops the pass, once this market's progress is saved.
      if (isRateLimited(err)) rateLimited = { error: err }
      answer = []
    }
    const txs = inRequestOrder(chunk, answer)
    for (const [j, sig] of chunk.entries()) {
      const tx = txs[j]
      // Not yet available (missing from the answer, or the node has not got it), or no block
      // time or meta: stop here and leave the rest for the next tick. Inserts are idempotent, so
      // reading a later transaction again is harmless. The signature check cannot fail after
      // inRequestOrder; it stays as a guard on what gets written under `sig`.
      if (
        !tx ||
        tx.blockTime === null ||
        tx.blockTime === undefined ||
        !tx.meta ||
        tx.transaction.signatures[0] !== sig
      ) {
        stoppedAt = sig
        break scan
      }
      const d = decodeTransaction(sig, tx, {
        market: m,
        collateralMint: deps.collateralMint.toBase58(),
        authority: deps.authority.toBase58(),
        log: deps.log,
        onSkip: (skippedSig, ixIndex) => skipped.push({ sig: skippedSig, ixIndex }),
        ...(deps.sponsor ? { sponsor: deps.sponsor.toBase58() } : {}),
      })
      await insertTrades(deps.db, d.trades)
      await insertClaims(deps.db, d.claims)
      const createdAt = new Date(tx.blockTime * 1000)
      await recordSponsoredAtas(
        deps.db,
        d.sponsoredAtas.map((a) => ({ ...a, createdSig: sig, createdAt })),
      )
      // The row is gone for good (the cursor moves on): make the lost P&L visible.
      for (const k of skipped.splice(0)) {
        await deps.alerts.send(
          `index-skip:${m.pubkey}`,
          `Indexing of ${m.gameId} (market ${m.pubkey}) skipped a row: signature ${k.sig}, instruction ${k.ixIndex} has no readable, consistent token flows`,
        )
      }
      trades += d.trades.length
      claims += d.claims.length
      externalLp ||= d.externalLp
      processed = sig
    }
  }
  if (stoppedAt) await noteStop(deps, m, stoppedAt)
  else if (!partial && !rateLimited) stops.delete(m.pubkey)
  // Without a stop everything fetched is done, failed signatures included, so a market with
  // failing swaps does not page through the same failures every tick.
  const cursor = stoppedAt || partial || rateLimited ? processed : newestFetched
  if (cursor) {
    await updateMarket(deps.db, m.pubkey, {
      indexCursor: cursor,
      ...(externalLp && !m.externalLp ? { externalLp: true } : {}),
    })
    const slot = slots.get(cursor)
    if (slot !== undefined) marks?.cursorAt(m.pubkey, slot)
  }
  if (externalLp && !m.externalLp) {
    await deps.alerts.send(
      `external-lp:${m.pubkey}`,
      `External liquidity added to ${m.gameId}; the pool is no longer Horagon's alone`,
    )
  }
  if (rateLimited) throw new RateLimitedPass(rateLimited.error)
  return { trades, claims, ...(partial ? { partial: true as const } : {}) }
}
