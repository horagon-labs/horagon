// The one SPL Memo a Horagon transaction may carry: `horagon:bot`, with no accounts. A client
// adds it to declare itself a bot (spec 4.2, docs/metrics.md bot rule (a)); the sponsor allows
// exactly this instruction and no other Memo.
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { Buffer } from 'buffer'

/** SPL Memo v2. The v1 program (`Memo1Uhk…`) is a different program and is never allowed. */
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
export const BOT_MEMO = 'horagon:bot'
const BOT_MEMO_BYTES = Buffer.from(BOT_MEMO, 'utf8')

export function botMemoIx(): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(BOT_MEMO_BYTES),
  })
}

/** The instruction is the bot memo: Memo v2, no accounts, data exactly `horagon:bot`. */
export function isBotMemoInstruction(
  programId: PublicKey,
  accountCount: number,
  data: Uint8Array,
): boolean {
  return (
    programId.equals(MEMO_PROGRAM_ID) &&
    accountCount === 0 &&
    data.length === BOT_MEMO_BYTES.length &&
    BOT_MEMO_BYTES.every((byte, i) => data[i] === byte)
  )
}
