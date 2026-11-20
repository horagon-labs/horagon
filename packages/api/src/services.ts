// The work behind each route, free of HTTP: quote, build trade and claim transactions, read
// transaction status and positions. Routes only parse, call one of these and serialize.

import { Buffer } from 'node:buffer'
import {
  getMarket,
  latestPrices,
  type MarketRow,
  marketsByPubkeys,
  walletActivity,
} from '@horagon/db'
import {
  type AtaSpec,
  ataAddress,
  buildClaimTransactions,
  buildTradeTransaction,
  effectiveTime,
  formatAmount,
  fromProgramError,
  type MarketAccount,
  type Position,
  parseAmount,
  type Quote,
  type QuoteRequest,
  quoteSwap,
  type SwapQuote,
  swapDirectionFor,
  type TradeBuildRequest,
  type TxStatus,
  toPoolState,
  tradeAtas,
} from '@horagon/sdk'
import { PublicKey, type VersionedTransaction } from '@solana/web3.js'
import { type ChainReader, rpc, tokenAmount } from './chain'
import type { ApiDeps } from './deps'
import { aggregatePositions } from './positions'
import { ApiError } from './problem'

/** A blockhash from `getLatestBlockhash` stays valid ~60-90 s; report the safe end. */
const BLOCKHASH_LIFETIME_MS = 60_000

export interface Ctx {
  deps: ApiDeps
  chain: ChainReader
}

/** The DB row (proof it is a Horagon market) and the live account, or NOT_FOUND. */
export async function horagonMarket(
  ctx: Ctx,
  pubkey: string,
): Promise<{ row: MarketRow; account: MarketAccount }> {
  const row = await getMarket(ctx.deps.db, pubkey)
  if (!row) throw new ApiError('NOT_FOUND', `${pubkey} is not a Horagon market`)
  return { row, account: await ctx.chain.market(new PublicKey(pubkey)) }
}

function assertTradable(row: MarketRow, account: MarketAccount, now: number): void {
  if (account.resolved || now >= account.endTs) {
    throw new ApiError('MARKET_CLOSED', 'This market no longer accepts trades')
  }
  if (row.status === 'halted' || account.totalLpShares === 0n) {
    throw new ApiError('MARKET_HALTED', 'Trading on this market is halted')
  }
}

export function toQuoteWire(q: SwapQuote, now: number): Quote {
  return {
    direction: q.direction,
    amountIn: formatAmount(q.amountIn),
    amountOut: formatAmount(q.amountOut),
    minOut: formatAmount(q.minOut),
    feeUsdc: formatAmount(q.fee),
    avgPrice: q.avgPrice,
    priceBefore: q.priceBefore,
    priceAfter: q.priceAfter,
    priceImpactBps: q.priceImpactBps,
    now,
  }
}

export async function quote(ctx: Ctx, req: QuoteRequest) {
  const { row, account } = await horagonMarket(ctx, req.market)
  // The same effective time quoteSwap uses, so the answer's `now` and its numbers agree.
  const now = effectiveTime(ctx.deps.now(), account.lastAccrualTs)
  assertTradable(row, account, now)
  const q = quoteSwap({
    pool: toPoolState(account),
    direction: swapDirectionFor(req.side, req.action),
    amountIn: parseAmount(req.amount),
    now,
    ...(req.slippageBps === undefined ? {} : { slippageBps: req.slippageBps }),
  })
  return { q, row, account, now }
}

function base64(tx: VersionedTransaction): string {
  return Buffer.from(tx.serialize()).toString('base64')
}

export async function buildTrade(ctx: Ctx, req: TradeBuildRequest) {
  const { q, account, now } = await quote(ctx, req)
  const user = new PublicKey(req.wallet)
  const sponsored = req.sponsored ?? true
  const sponsor = ctx.deps.sponsor?.keypair.publicKey
  if (sponsored && !sponsor) {
    throw new ApiError('SPONSOR_REJECTED', 'Sponsored trades are off; send with sponsored: false')
  }
  const feePayer = sponsored && sponsor ? sponsor : user
  const market = new PublicKey(req.market)
  const atas = tradeAtas({
    user,
    market,
    collateralMint: account.collateralMint,
    authority: account.authority,
  })
  const infos = await ctx.chain.accounts(atas.map(ataAddress))
  // The user's own balance decides early whether the swap can succeed (better than a
  // simulation failure): mUSDC for a buy, the side's shares for a sell.
  const spendIndex = req.action === 'buy' ? 0 : req.side === 'home' ? 1 : 2
  const balance = tokenAmount(infos[spendIndex] ?? null)
  if (balance < q.amountIn) {
    throw new ApiError(
      'INSUFFICIENT_FUNDS',
      req.action === 'buy'
        ? `Wallet holds ${formatAmount(balance)} mUSDC, the trade needs ${formatAmount(q.amountIn)}`
        : `Wallet holds ${formatAmount(balance)} shares, the order sells ${formatAmount(q.amountIn)}`,
      req.action === 'buy' ? { hint: 'Get 1,000 mUSDC from the faucet, then retry.' } : {},
    )
  }
  const { blockhash } = await ctx.chain.blockhash()
  const tx = buildTradeTransaction({
    feePayer,
    recentBlockhash: blockhash,
    swap: {
      user,
      market,
      collateralMint: account.collateralMint,
      authority: account.authority,
      direction: q.direction,
      amountIn: q.amountIn,
      minOut: q.minOut,
    },
    createAtas: atas.filter((_, i) => !infos[i]),
  })
  return {
    tx: base64(tx),
    feePayer: feePayer.toBase58(),
    quote: toQuoteWire(q, now),
    expiresAt: Date.now() + BLOCKHASH_LIFETIME_MS,
  }
}

/** Every resolved market where the wallet holds winning tokens, as claim transactions. */
export async function buildClaims(ctx: Ctx, req: { wallet: string; sponsored?: boolean }) {
  const user = new PublicKey(req.wallet)
  const { trades, claims } = await walletActivity(ctx.deps.db, req.wallet)
  const keys = [...new Set([...trades, ...claims].map((r) => r.market))]
  const rows = (await marketsByPubkeys(ctx.deps.db, keys)).filter(
    (m) => m.status === 'finalized' || m.status === 'recycled',
  )
  if (rows.length === 0) return { txs: [], markets: [] }
  const accounts = await Promise.all(rows.map((m) => ctx.chain.market(new PublicKey(m.pubkey))))
  const candidates = rows
    .map((row, i) => ({ row, account: accounts[i] as MarketAccount }))
    .filter(({ account }) => account.resolved)
  // [YES ATA, NO ATA] per candidate; claim_winnings needs both to exist.
  const outcomeAtas = candidates.flatMap(({ account }) => [
    { owner: user, mint: account.yesMint },
    { owner: user, mint: account.noMint },
  ])
  const collateralMint = ctx.deps.collateralMint
  const [collateralInfo, ...outcomeInfos] = await ctx.chain.accounts([
    ataAddress({ owner: user, mint: collateralMint }),
    ...outcomeAtas.map(ataAddress),
  ])
  const claimable = candidates.flatMap(({ row, account }, i) => {
    const yes = outcomeInfos[2 * i] ?? null
    const no = outcomeInfos[2 * i + 1] ?? null
    const winning = account.winningSide === 1 ? yes : no
    if (tokenAmount(winning) === 0n) return []
    const missing = [yes, no].flatMap((info, j) =>
      info ? [] : [outcomeAtas[2 * i + j] as AtaSpec],
    )
    return [{ row, account, missing }]
  })
  if (claimable.length === 0) return { txs: [], markets: [] }
  const sponsored = req.sponsored ?? true
  const sponsor = ctx.deps.sponsor?.keypair.publicKey
  if (sponsored && !sponsor) {
    throw new ApiError('SPONSOR_REJECTED', 'Sponsored claims are off; send with sponsored: false')
  }
  const feePayer = sponsored && sponsor ? sponsor : user
  const { blockhash } = await ctx.chain.blockhash()
  const txs = buildClaimTransactions({
    user,
    feePayer,
    recentBlockhash: blockhash,
    markets: claimable.map(({ row, account, missing }) => ({
      market: new PublicKey(row.pubkey),
      collateralMint: account.collateralMint,
      createAtas: missing,
    })),
    closeAccounts: true,
    // Sponsored ATAs were paid for by the sponsor, so their rent goes back to it.
    rentDestination: feePayer,
    ...(collateralInfo ? {} : { createCollateralAta: { owner: user, mint: collateralMint } }),
  })
  const expiresAt = Date.now() + BLOCKHASH_LIFETIME_MS
  return {
    txs: txs.map((tx) => ({ tx: base64(tx), feePayer: feePayer.toBase58(), expiresAt })),
    markets: claimable.map(({ row }) => row.pubkey),
  }
}

export async function txStatus(ctx: Ctx, signature: string): Promise<TxStatus> {
  const res = await rpc('getSignatureStatuses', () =>
    ctx.deps.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }),
  )
  const s = res.value[0]
  if (!s) return { signature, status: 'unknown', slot: null, error: null }
  if (s.err) {
    const e = fromProgramError(s.err)
    return {
      signature,
      status: 'failed',
      slot: s.slot,
      error: {
        code: e.code,
        message: e.message,
        ...(e.programCode === undefined ? {} : { programCode: e.programCode }),
      },
    }
  }
  const status =
    s.confirmationStatus === 'finalized'
      ? 'finalized'
      : s.confirmationStatus === 'confirmed'
        ? 'confirmed'
        : 'pending'
  return { signature, status, slot: s.slot, error: null }
}

/** The wallet's mUSDC, or null when the RPC is down (positions still come from the DB). */
export async function usdcBalanceOf(ctx: Ctx, wallet: string): Promise<string | null> {
  const ata = ataAddress({ owner: new PublicKey(wallet), mint: ctx.deps.collateralMint })
  try {
    const [info] = await ctx.chain.accounts([ata])
    return formatAmount(tokenAmount(info ?? null))
  } catch (err) {
    if (err instanceof ApiError && err.code === 'NETWORK') return null
    throw err
  }
}

export async function positionsFor(ctx: Ctx, wallet: string): Promise<Position[]> {
  const { trades, claims } = await walletActivity(ctx.deps.db, wallet)
  const keys = [...new Set([...trades, ...claims].map((r) => r.market))]
  const [markets, latest] = await Promise.all([
    marketsByPubkeys(ctx.deps.db, keys),
    latestPrices(ctx.deps.db, keys),
  ])
  const prices = new Map([...latest].map(([k, v]) => [k, v.price]))
  return aggregatePositions({ trades, claims, markets, prices })
}
