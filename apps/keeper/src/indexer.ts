// Indexer (spec 8): every 5 s, new signatures of each market not recycled (or recycled less
// than a day ago), decoded into trades and redeems/claims from token balance deltas, plus one
// price point per open market. Only top-level pm-AMM instructions are user activity; the same
// instructions inside a Horagon transaction are the keeper's own CPIs. Token accounts that a
// sponsored transaction created for its user are recorded for `ata-watch.ts`.
import {
  type Db,
  insertClaims,
  insertPricePoint,
  insertTrades,
  listIndexableMarkets,
  type MarketRow,
  recordSponsoredAtas,
  updateMarket,
} from '@horagon/db'
import {
  decodeMarketAccount,
  errorSummary,
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

type TradeInsert = Parameters<typeof insertTrades>[1][number]
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
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Base58 text to bytes: a transaction response gives inner instruction data in base58. */
export function base58Decode(text: string): Uint8Array {
  const bytes: number[] = []
  for (const ch of text) {
    let carry = B58.indexOf(ch)
    if (carry < 0) throw new Error('bad base58')
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] as number) * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  for (const ch of text) {
    if (ch !== '1') break
    bytes.push(0)
  }
  return Uint8Array.from(bytes.reverse())
}

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
      })
    } else if (name === 'redeemPair' || name === 'claimWinnings') {
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
  connection: Connection
  collateralMint: PublicKey
  authority: PublicKey
  alerts: Alerter
  log: Logger
  now: () => number
  /** The sponsor; when set, the ATAs it paid for are recorded. */
  sponsor?: PublicKey
  /** Stop counters per market; defaults to a module-level map. */
  stops?: Map<string, StopState>
}

/** One pass over every indexable market. Returns how many rows were written. */
export async function indexOnce(
  deps: IndexerDeps,
): Promise<{ trades: number; claims: number; prices: number }> {
  const now = deps.now()
  const markets = await listIndexableMarkets(deps.db, new Date(now * 1000))
  let trades = 0
  let claims = 0
  let prices = 0
  for (const m of markets) {
    try {
      const r = await indexMarket(deps, m)
      trades += r.trades
      claims += r.claims
    } catch (err) {
      deps.log.warn({ market: m.pubkey, error: errorSummary(err).message }, 'index failed')
    }
  }
  const open = markets.filter((m) => m.status === 'open' && m.endTs.getTime() / 1000 > now)
  if (open.length > 0) {
    let infos: Awaited<ReturnType<Connection['getMultipleAccountsInfo']>>
    try {
      infos = await deps.connection.getMultipleAccountsInfo(
        open.map((m) => new PublicKey(m.pubkey)),
        'confirmed',
      )
    } catch (err) {
      deps.log.warn({ error: errorSummary(err).message }, 'price read failed')
      return { trades, claims, prices }
    }
    for (const [i, info] of infos.entries()) {
      const m = open[i]
      if (!info || !m) continue
      try {
        const live = liveMarket(decodeMarketAccount(info), now)
        if (live.price === null) continue
        await insertPricePoint(deps.db, {
          market: m.pubkey,
          ts: new Date(now * 1000),
          price: live.price,
        })
        prices++
      } catch (err) {
        deps.log.warn({ market: m.pubkey, error: errorSummary(err).message }, 'price point failed')
      }
    }
  }
  return { trades, claims, prices }
}

/**
 * A market stopped at `sig`: warn at most once a minute per market; from STUCK_AFTER stops on,
 * send `index-stuck` on every stop. The alerter's dedupe throttles it, and re-arms the key after
 * a failed delivery, which is why this must not be a one-shot.
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
      'transaction not readable yet; indexing waits',
    )
  }
  if (st.count >= STUCK_AFTER) {
    await deps.alerts.send(
      `index-stuck:${m.pubkey}`,
      `Indexing of ${m.gameId} (market ${m.pubkey}) is stuck: signature ${sig} has been unreadable for ${st.count} passes`,
    )
  }
}

async function indexMarket(
  deps: IndexerDeps,
  m: MarketRow,
): Promise<{ trades: number; claims: number }> {
  const stops = deps.stops ?? defaultStops
  const address = new PublicKey(m.pubkey)
  const sigs: string[] = []
  let newestFetched: string | undefined
  let before: string | undefined
  // Newest first; page back until the cursor (the newest signature already indexed).
  for (;;) {
    const page = await deps.connection.getSignaturesForAddress(
      address,
      {
        limit: 1000,
        ...(before ? { before } : {}),
        ...(m.indexCursor ? { until: m.indexCursor } : {}),
      },
      'confirmed',
    )
    newestFetched ??= page[0]?.signature
    sigs.push(...page.filter((s) => s.err === null).map((s) => s.signature))
    if (page.length < 1000) break
    before = page.at(-1)?.signature
  }
  // Nothing fetched: the market did not move past a signature, so a stall counter stays.
  if (!newestFetched) {
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
  scan: for (let i = 0; i < ordered.length; i += 50) {
    const chunk = ordered.slice(i, i + 50)
    const txs = await deps.connection.getTransactions(chunk, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    })
    for (const [j, sig] of chunk.entries()) {
      const tx = txs[j]
      // Not yet available, no block time or meta, or not the transaction asked for (a short or
      // reordered batch): stop here and leave the rest for the next tick. Inserts are
      // idempotent, so reading a later transaction again is harmless.
      if (
        !tx ||
        txs.length !== chunk.length ||
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
          `Indexing of ${m.gameId} (market ${m.pubkey}) skipped a row: signature ${k.sig}, instruction ${k.ixIndex} has no readable token flows`,
        )
      }
      trades += d.trades.length
      claims += d.claims.length
      externalLp ||= d.externalLp
      processed = sig
    }
  }
  if (stoppedAt) await noteStop(deps, m, stoppedAt)
  else stops.delete(m.pubkey)
  // Without a stop everything fetched is done, failed signatures included, so a market with
  // failing swaps does not page through the same failures every tick.
  const cursor = stoppedAt ? processed : newestFetched
  if (cursor) {
    await updateMarket(deps.db, m.pubkey, {
      indexCursor: cursor,
      ...(externalLp && !m.externalLp ? { externalLp: true } : {}),
    })
  }
  if (externalLp && !m.externalLp) {
    await deps.alerts.send(
      `external-lp:${m.pubkey}`,
      `External liquidity added to ${m.gameId}; the pool is no longer Horagon's alone`,
    )
  }
  return { trades, claims }
}
