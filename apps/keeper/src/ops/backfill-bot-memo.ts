// `horagon-ops backfill-bot-memo`: fills trades.bot_memo for the trades indexed before the column
// existed (null) by reading each transaction again from chain. Safe to run again: it reads only
// the transactions still unset, oldest first, and stops at the first one the RPC cannot return,
// keeping what it already wrote.
import {
  countTradesWithoutBotMemo,
  type Db,
  setTradeBotMemo,
  tradeSigsWithoutBotMemo,
} from '@horagon/db'
import type { VersionedTransactionResponse } from '@solana/web3.js'
import { hasBotMemo, inRequestOrder } from '../indexer'

export interface BackfillDeps {
  db: Db
  /** The batch answer, in any order; a signature with no matching response is not available. */
  getTransactions(sigs: string[]): Promise<Array<VersionedTransactionResponse | null>>
  /** Progress, one line per batch. */
  log?: (line: string) => void
}

export interface BackfillResult {
  /** Transactions read and written. */
  read: number
  /** Of those, transactions with the horagon:bot memo. */
  bots: number
  /** Transactions still unset afterwards. */
  left: number
}

export async function backfillBotMemo(deps: BackfillDeps, batch = 50): Promise<BackfillResult> {
  if (!Number.isInteger(batch) || batch < 1) throw new Error('batch must be a positive integer')
  let read = 0
  let bots = 0
  for (;;) {
    const sigs = await tradeSigsWithoutBotMemo(deps.db, batch)
    if (sigs.length === 0) break
    // Paired by signature: the RPC may answer the batch in any order.
    const txs = inRequestOrder(sigs, await deps.getTransactions(sigs))
    for (const [i, sig] of sigs.entries()) {
      const tx = txs[i]
      if (!tx) throw new Error(`transaction ${sig} is not available from the RPC; run again later`)
      const memo = hasBotMemo(tx)
      // Zero rows set would list the same signature again forever.
      if ((await setTradeBotMemo(deps.db, sig, memo)) === 0) {
        throw new Error(`internal: no unset trade row for ${sig}`)
      }
      read++
      if (memo) bots++
    }
    deps.log?.(`bot_memo: ${read} transactions read, ${bots} with the bot memo`)
  }
  return { read, bots, left: await countTradesWithoutBotMemo(deps.db) }
}
