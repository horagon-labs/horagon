// One zod schema per concept, shared by the SDK client, API v1 (input and output) and, from
// Tier 2, the CLI and MCP. Amounts on the wire are decimal strings ("12.5"), times are unix
// seconds unless the field name says ISO.
import { z } from 'zod'
import { HORAGON_ERROR_CODES } from './errors'
import { SWAP_DIRECTIONS, type SwapDirection } from './math/curve'

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** How many bytes `value` decodes to in base58, or null for a character outside the alphabet. */
function base58Bytes(value: string): number | null {
  let zeros = 0
  while (value[zeros] === '1') zeros++
  let n = 0n
  for (const c of value) {
    const digit = BASE58.indexOf(c)
    if (digit < 0) return null
    n = n * 58n + BigInt(digit)
  }
  let bytes = 0
  for (; n > 0n; n >>= 8n) bytes++
  return zeros + bytes
}

/**
 * What `new PublicKey(value).toBase58() === value` accepts, without web3.js, so a page that checks
 * API answers with these schemas does not load it (R5c): base58 that decodes to exactly 32 bytes.
 * A base58 text has one spelling per byte string (each leading "1" is one zero byte), so the
 * round trip adds nothing to the length check. Off-curve keys (PDAs) pass, as before. zod runs
 * this refine even on a string its regex refused, so a long one is refused here before the
 * BigInt work, which grows with the square of the length.
 */
function isPubkey(value: string): boolean {
  return value.length <= 44 && base58Bytes(value) === 32
}

export const PubkeySchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'a base58 public key')
  .refine(isPubkey, 'not a valid public key')
export const SignatureSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/, 'a signature')
export const AmountSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/, 'a decimal amount with at most 6 decimals')
/** `nba-401910007`: league, a dash, then the feed's game id (ESPN event id in Tier 1). */
export const GameIdSchema = z.string().regex(/^[a-z]{2,8}-[A-Za-z0-9]{1,16}$/, 'a game id')
export const UnixSecondsSchema = z.number().int().nonnegative()
export const ProbabilitySchema = z.number().min(0).max(1)

export const GameStatusSchema = z.enum(['scheduled', 'live', 'final', 'postponed', 'canceled'])
export const MarketKindSchema = z.enum(['winner', 'second-half'])
export const MarketStatusSchema = z.enum([
  'open',
  'halted',
  'proposed',
  'challenged',
  'finalized',
  'recycled',
])
export const SideSchema = z.enum(['home', 'away'])
export const TradeActionSchema = z.enum(['buy', 'sell'])
export const OutcomeSchema = z.enum(['yes', 'no'])
export const SwapDirectionSchema = z.enum(SWAP_DIRECTIONS as [string, ...string[]])

export const MarketSummarySchema = z.object({
  pubkey: PubkeySchema,
  kind: MarketKindSchema,
  status: MarketStatusSchema,
  endTs: UnixSecondsSchema,
  initialPriceBps: z.number().int().min(0).max(10_000),
  seedUsdc: AmountSchema,
  /** Last indexed YES price (the home team's implied win probability), if any. */
  price: ProbabilitySchema.nullable(),
  priceTs: UnixSecondsSchema.nullable(),
  outcome: OutcomeSchema.nullable(),
})

export const GameSchema = z.object({
  id: GameIdSchema,
  league: z.string(),
  home: z.string(),
  away: z.string(),
  scheduledTipoff: z.iso.datetime(),
  status: GameStatusSchema,
  homeScore: z.number().int(),
  awayScore: z.number().int(),
  period: z.number().int(),
  /** Seconds left in the current period; null before tip-off and after the end. */
  clockSecs: z.number().int().nullable(),
  featured: z.boolean(),
  /**
   * The keeper's in-game model probability that the home team wins (spec section 7): the YES
   * side of a winner market. Shown to fans, and the price the reference agent trades toward.
   */
  modelProb: ProbabilitySchema.nullable(),
  markets: z.array(MarketSummarySchema),
  updatedAt: z.iso.datetime(),
})

export const ResolutionSchema = z.object({
  market: PubkeySchema,
  kind: MarketKindSchema,
  status: MarketStatusSchema,
  outcome: OutcomeSchema.nullable(),
  evidenceHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  evidenceUrl: z.string().nullable(),
  createSig: SignatureSchema.nullable(),
  haltSig: SignatureSchema.nullable(),
  proposeSig: SignatureSchema.nullable(),
  finalizeSig: SignatureSchema.nullable(),
  recycleSig: SignatureSchema.nullable(),
  /** Someone besides Horagon deposited liquidity; `halt` withdraws only Horagon's share. */
  externalLp: z.boolean(),
})

const CountSchema = z.number().int().nonnegative()
/** Swaps on a game's markets, the wallets that sent them and their USDC volume. */
export const TradeTallySchema = z.object({
  swaps: CountSchema,
  wallets: CountSchema,
  /** The absolute USDC leg of every buy and sell; a YES<->NO swap adds 0. */
  volumeUsdc: AmountSchema,
})

/**
 * Who traded a game (R2b): the reference agent is its wallet exactly; `others` holds the other
 * team wallets and the bots (the `horagon:bot` memo on any market, or 20 swaps on this game
 * within 300 s); everyone else is a fan. A live display: `scripts/count-fans.mjs` is the count.
 */
export const GameActivitySchema = z.object({
  agent: TradeTallySchema.extend({ wallet: PubkeySchema }),
  fans: TradeTallySchema,
  others: TradeTallySchema,
  lastFanTradeTs: UnixSecondsSchema.nullable(),
  lastAgentTradeTs: UnixSecondsSchema.nullable(),
})

export const GameDetailSchema = GameSchema.extend({
  /** The "Market rules" text, one rule per item (spec section 6.2). */
  rules: z.array(z.string()),
  resolutions: z.array(ResolutionSchema),
})

export const GamesQuerySchema = z.strictObject({
  /**
   * YYYY-MM-DD, the US Eastern (ET) day of tip-off, as the NBA dates its games.
   * Default: from 00:00 ET of the night (the ET date of now - 6 h, `etNight`, so the night
   * rolls over at 06:00 ET) to the end of the next ET day.
   */
  date: z.iso.date().optional(),
  status: z
    .string()
    .transform((s) => s.split(','))
    .pipe(z.array(GameStatusSchema))
    .optional(),
})

export const HistorySchema = z.object({
  gameId: GameIdSchema,
  snapshots: z.array(
    z.object({
      ts: UnixSecondsSchema,
      homeScore: z.number().int(),
      awayScore: z.number().int(),
      period: z.number().int(),
      clockSecs: z.number().int().nullable(),
      modelProb: ProbabilitySchema.nullable(),
    }),
  ),
  prices: z.array(
    z.object({ market: PubkeySchema, ts: UnixSecondsSchema, price: ProbabilitySchema }),
  ),
})

export const MarketStateSchema = z.object({
  pubkey: PubkeySchema,
  gameId: GameIdSchema,
  kind: MarketKindSchema,
  status: MarketStatusSchema,
  authority: PubkeySchema,
  collateralMint: PubkeySchema,
  yesMint: PubkeySchema,
  noMint: PubkeySchema,
  startTs: UnixSecondsSchema,
  endTs: UnixSecondsSchema,
  /** The time the state below was rescaled to. */
  now: UnixSecondsSchema,
  /** YES price at `now`. */
  price: ProbabilitySchema,
  /** L_eff = L_0 * sqrt(endTs - now), in mUSDC: how deep the pool is right now. */
  liquidityUsdc: AmountSchema,
  resolved: z.boolean(),
  winningSide: OutcomeSchema.nullable(),
  externalLp: z.boolean(),
})

export const QuoteRequestSchema = z.strictObject({
  market: PubkeySchema,
  side: SideSchema,
  action: TradeActionSchema,
  /** mUSDC to spend when buying, shares to sell when selling. */
  amount: AmountSchema,
  slippageBps: z.coerce.number().int().min(0).max(10_000).optional(),
})

export const QuoteSchema = z.object({
  direction: SwapDirectionSchema,
  amountIn: AmountSchema,
  amountOut: AmountSchema,
  minOut: AmountSchema,
  feeUsdc: AmountSchema,
  avgPrice: z.number(),
  priceBefore: ProbabilitySchema,
  priceAfter: ProbabilitySchema,
  priceImpactBps: z.number().int(),
  /** The unix time the quote was computed for. */
  now: UnixSecondsSchema,
})

export const TradeBuildRequestSchema = QuoteRequestSchema.extend({
  wallet: PubkeySchema,
  /** Default true: the sponsor pays the fee and ATA rent (spec section 9). */
  sponsored: z.boolean().optional(),
  /** "bot": the transaction carries the horagon:bot memo, so the wallet counts as a bot (spec 4.2). */
  client: z.literal('bot').optional(),
})

export const BuiltTxWireSchema = z.object({
  /** base64 of an unsigned v0 transaction. */
  tx: z.base64(),
  feePayer: PubkeySchema,
  quote: QuoteSchema.optional(),
  /** Unix ms after which the blockhash may have expired; rebuild after that. */
  expiresAt: z.number().int(),
})

export const ClaimBuildRequestSchema = z.strictObject({
  wallet: PubkeySchema,
  sponsored: z.boolean().optional(),
})

export const ClaimBuildResponseSchema = z.object({
  txs: z.array(BuiltTxWireSchema),
  markets: z.array(PubkeySchema),
})

export const SubmitRequestSchema = z.strictObject({ tx: z.base64().max(2_048) })
export const SubmitResponseSchema = z.object({ signature: SignatureSchema })

export const TxStatusSchema = z.object({
  signature: SignatureSchema,
  status: z.enum(['pending', 'confirmed', 'finalized', 'failed', 'unknown']),
  slot: z.number().int().nullable(),
  error: z
    .object({
      code: z.enum(HORAGON_ERROR_CODES),
      message: z.string(),
      hint: z.string().optional(),
      programCode: z.number().int().optional(),
    })
    .nullable(),
})

export const PositionSchema = z.object({
  market: PubkeySchema,
  gameId: GameIdSchema,
  kind: MarketKindSchema,
  side: SideSchema,
  shares: AmountSchema,
  costUsdc: AmountSchema,
  /** shares * current price (open market) or the payout (resolved). */
  valueUsdc: AmountSchema,
  /** Signed decimal string. */
  pnlUsdc: z.string().regex(/^-?(0|[1-9]\d*)(\.\d{1,6})?$/),
  price: ProbabilitySchema.nullable(),
  marketStatus: MarketStatusSchema,
  outcome: OutcomeSchema.nullable(),
  claimable: z.boolean(),
})

export const PositionsResponseSchema = z.object({
  wallet: PubkeySchema,
  /** mUSDC in the wallet's token account ("0" if it has none); null while RPC is down. */
  usdcBalance: AmountSchema.nullable(),
  positions: z.array(PositionSchema),
})

export const FaucetRequestSchema = z.strictObject({ wallet: PubkeySchema })
export const FaucetResponseSchema = z.object({
  signature: SignatureSchema.nullable(),
  amountUsdc: AmountSchema,
})

export const HealthSchema = z.object({
  ok: z.boolean(),
  db: z.object({ ok: z.boolean(), ms: z.number() }),
  rpc: z.object({ ok: z.boolean(), ms: z.number(), slot: z.number().int().nullable() }),
  keeper: z.object({ ok: z.boolean(), heartbeatAgeSecs: z.number().nullable() }),
  version: z.string(),
})

/** RFC 9457 problem details, with Horagon's error code (spec section 19.3). */
export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  code: z.enum(HORAGON_ERROR_CODES),
  hint: z.string().optional(),
  programCode: z.number().int().optional(),
  /** Sponsor rejection reason (SPONSOR_REJECTED only). */
  reason: z.string().optional(),
  requestId: z.string().optional(),
})

/** Tier 2 feature flags (spec 3.3); every one is off until `horagon-ops flag on` turns it on. */
export const FlagsSchema = z.strictObject({
  FLAG_ME: z.boolean(),
  FLAG_METRICS: z.boolean(),
  FLAG_METRICS_COHORT: z.boolean(),
  FLAG_SHARE: z.boolean(),
  FLAG_RANK: z.boolean(),
  FLAG_CREWS: z.boolean(),
  FLAG_TELEGRAM: z.boolean(),
  FLAG_CLUTCH: z.boolean(),
  FLAG_PRACTICE: z.boolean(),
  FLAG_VERIFY: z.boolean(),
})

/** `GET /api/v1/flags`. */
export const FlagsResponseSchema = z.object({ flags: FlagsSchema })

export type GameStatus = z.infer<typeof GameStatusSchema>
export type MarketKind = z.infer<typeof MarketKindSchema>
export type MarketStatus = z.infer<typeof MarketStatusSchema>
export type Side = z.infer<typeof SideSchema>
export type TradeAction = z.infer<typeof TradeActionSchema>
export type Outcome = z.infer<typeof OutcomeSchema>
export type MarketSummary = z.infer<typeof MarketSummarySchema>
export type Game = z.infer<typeof GameSchema>
export type GameDetail = z.infer<typeof GameDetailSchema>
export type GameActivity = z.infer<typeof GameActivitySchema>
export type TradeTally = z.infer<typeof TradeTallySchema>
export type Resolution = z.infer<typeof ResolutionSchema>
export type GameHistory = z.infer<typeof HistorySchema>
export type MarketState = z.infer<typeof MarketStateSchema>
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>
export type Quote = z.infer<typeof QuoteSchema>
export type TradeBuildRequest = z.infer<typeof TradeBuildRequestSchema>
export type BuiltTxWire = z.infer<typeof BuiltTxWireSchema>
export type ClaimBuildResponse = z.infer<typeof ClaimBuildResponseSchema>
export type TxStatus = z.infer<typeof TxStatusSchema>
export type Position = z.infer<typeof PositionSchema>
export type PositionsResponse = z.infer<typeof PositionsResponseSchema>
export type FaucetResponse = z.infer<typeof FaucetResponseSchema>
export type Health = z.infer<typeof HealthSchema>
export type Problem = z.infer<typeof ProblemSchema>
export type FlagsResponse = z.infer<typeof FlagsResponseSchema>

/** On-chain `GameMarket.kind` <-> API name. */
export const MARKET_KIND_CODE: Readonly<Record<MarketKind, 0 | 1>> = { winner: 0, 'second-half': 1 }
export const marketKindName = (code: number): MarketKind => (code === 1 ? 'second-half' : 'winner')

/** Home = YES (the home team wins), away = NO. */
export function swapDirectionFor(side: Side, action: TradeAction): SwapDirection {
  if (action === 'buy') return side === 'home' ? 'usdcToYes' : 'usdcToNo'
  return side === 'home' ? 'yesToUsdc' : 'noToUsdc'
}
