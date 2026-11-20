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
import { ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token'
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
  msg.compiledInstructions.forEach((ix, ixIndex) => {
    if (keys[ix.programIdIndex] !== PM_AMM_PROGRAM_ID.toBase58()) return
    if (!ix.accountKeyIndexes.some((i) => keys[i] === m.pubkey)) return
    const name = pmAmmInstructionName(ix.data)
    const usdc = deltas(tx, user, ctx.collateralMint)
    const yes = deltas(tx, user, m.yesMint)
    const no = deltas(tx, user, m.noMint)
    if (name === 'swap') {
      const direction = SWAP_DIRECTIONS[ix.data[8] ?? 255] ?? 'unknown'
      const fee =
        deltas(tx, PROTOCOL_DAO.toBase58(), ctx.collateralMint) +
        deltas(tx, ctx.authority, ctx.collateralMint)
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
        fee: fee > 0n ? fee : 0n,
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
    } else if (name === 'depositLiquidity' && user !== ctx.authority) {
      out.externalLp = true
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
    const infos = await deps.connection.getMultipleAccountsInfo(
      open.map((m) => new PublicKey(m.pubkey)),
      'confirmed',
    )
    for (const [i, info] of infos.entries()) {
      const m = open[i]
      if (!info || !m) continue
      const live = liveMarket(decodeMarketAccount(info), now)
      if (live.price === null) continue
      await insertPricePoint(deps.db, {
        market: m.pubkey,
        ts: new Date(now * 1000),
        price: live.price,
      })
      prices++
    }
  }
  return { trades, claims, prices }
}

async function indexMarket(
  deps: IndexerDeps,
  m: MarketRow,
): Promise<{ trades: number; claims: number }> {
  const address = new PublicKey(m.pubkey)
  const sigs: string[] = []
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
    sigs.push(...page.filter((s) => s.err === null).map((s) => s.signature))
    if (page.length < 1000) break
    before = page.at(-1)?.signature
  }
  if (sigs.length === 0) return { trades: 0, claims: 0 }
  const ordered = sigs.reverse()
  // The newest signature fully processed: the cursor never moves past a transaction not read.
  let processed: string | undefined
  let stoppedAt: string | undefined
  let trades = 0
  let claims = 0
  let externalLp = false
  scan: for (let i = 0; i < ordered.length; i += 50) {
    const chunk = ordered.slice(i, i + 50)
    const txs = await deps.connection.getTransactions(chunk, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    })
    for (const [j, tx] of txs.entries()) {
      const sig = chunk[j] as string
      // Not yet available (or no block time): stop here and leave the rest for the next tick.
      // Inserts are idempotent, so reading a later transaction again is harmless.
      if (!tx || tx.blockTime === null || tx.blockTime === undefined) {
        stoppedAt = sig
        break scan
      }
      const d = decodeTransaction(sig, tx, {
        market: m,
        collateralMint: deps.collateralMint.toBase58(),
        authority: deps.authority.toBase58(),
        ...(deps.sponsor ? { sponsor: deps.sponsor.toBase58() } : {}),
      })
      await insertTrades(deps.db, d.trades)
      await insertClaims(deps.db, d.claims)
      const createdAt = new Date(tx.blockTime * 1000)
      await recordSponsoredAtas(
        deps.db,
        d.sponsoredAtas.map((a) => ({ ...a, createdSig: sig, createdAt })),
      )
      trades += d.trades.length
      claims += d.claims.length
      externalLp ||= d.externalLp
      processed = sig
    }
  }
  if (stoppedAt) {
    deps.log.debug({ market: m.pubkey, sig: stoppedAt }, 'transaction not readable yet; will retry')
  }
  if (processed) {
    await updateMarket(deps.db, m.pubkey, {
      indexCursor: processed,
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
