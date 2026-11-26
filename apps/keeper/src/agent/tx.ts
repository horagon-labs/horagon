// The reference agent's transactions, built with the SDK's own builders: the trade builder with
// the `horagon:bot` memo (every agent swap declares itself a bot, docs/metrics.md bot rule (a)),
// and the claim builder. The keeper's TxSender then sends their instructions with the agent as
// the only signer and fee payer, adding its own compute budget and retrying like the keeper.
import {
  type AtaSpec,
  buildClaimTransactions,
  buildTradeTransaction,
  HoragonError,
} from '@horagon/sdk'
import {
  ComputeBudgetProgram,
  PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  type VersionedTransaction,
} from '@solana/web3.js'
import type { BuyDirection } from './decide'

/** Any blockhash will do: TxSender compiles a new message with a fresh one for every attempt. */
const PLACEHOLDER_BLOCKHASH = PublicKey.default.toBase58()

/** claim_winnings with its ATA creates: well under this (TxSender sets the limit). */
export const CLAIM_COMPUTE_UNITS = 400_000

/**
 * The instructions of an SDK-built transaction in their order, without its compute-budget ones:
 * TxSender sets the unit limit and a priority fee that rises on each retry.
 */
export function instructionsOf(tx: VersionedTransaction): TransactionInstruction[] {
  return TransactionMessage.decompile(tx.message).instructions.filter(
    (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
  )
}

export interface AgentSwapInput {
  /** The agent: the swap's user, the only signer and the fee payer. */
  agent: PublicKey
  market: PublicKey
  collateralMint: PublicKey
  /** The pm-AMM market's authority (Horagon's Authority PDA): receives the creator fee. */
  authority: PublicKey
  direction: BuyDirection
  amountIn: bigint
  minOut: bigint
  /** The ATAs of `tradeAtas` that do not exist yet; the agent pays their rent. */
  createAtas: readonly AtaSpec[]
}

/** [ATA creates..., the `horagon:bot` memo, the swap], from `buildTradeTransaction`. */
export function agentSwapInstructions(p: AgentSwapInput): TransactionInstruction[] {
  return instructionsOf(
    buildTradeTransaction({
      feePayer: p.agent,
      recentBlockhash: PLACEHOLDER_BLOCKHASH,
      swap: {
        user: p.agent,
        market: p.market,
        collateralMint: p.collateralMint,
        authority: p.authority,
        direction: p.direction,
        amountIn: p.amountIn,
        minOut: p.minOut,
      },
      createAtas: p.createAtas,
      botMemo: true,
    }),
  )
}

/**
 * One market's claim_winnings (with its missing YES or NO ATA created first), from
 * `buildClaimTransactions`. No memo: a claim is not a swap.
 */
export function agentClaimInstructions(p: {
  agent: PublicKey
  market: PublicKey
  collateralMint: PublicKey
  createAtas: readonly AtaSpec[]
}): TransactionInstruction[] {
  const txs = buildClaimTransactions({
    user: p.agent,
    feePayer: p.agent,
    recentBlockhash: PLACEHOLDER_BLOCKHASH,
    markets: [{ market: p.market, collateralMint: p.collateralMint, createAtas: p.createAtas }],
  })
  const [tx] = txs
  if (!tx || txs.length !== 1) throw new HoragonError('INVALID_INPUT', 'one claim, one transaction')
  return instructionsOf(tx)
}
