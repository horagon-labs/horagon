import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import {
  type Connection,
  type PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  type TokenBalance,
  type VersionedTransactionResponse,
} from '@solana/web3.js'
import { sleep } from './env'

export interface TxStats {
  signature: string
  slot: number
  blockTime: number
  computeUnits: number
  feeLamports: number
  sizeBytes: number
  maxInvokeDepth: number
}

/** Highest `invoke [n]` in the logs: the CPI depth the transaction reached. */
export function maxInvokeDepth(logs: readonly string[]): number {
  let depth = 0
  for (const line of logs) {
    const m = / invoke \[(\d+)\]$/.exec(line)
    if (m?.[1]) depth = Math.max(depth, Number(m[1]))
  }
  return depth
}

/** Poll until `signature` is confirmed; throw if it failed or timed out. */
export async function waitForSignature(
  connection: Connection,
  signature: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature])
    const status = value[0]
    if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`)
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return
    }
    await sleep(1_000)
  }
  throw new Error(`${signature} not confirmed after ${timeoutMs} ms`)
}

/** Fetch a confirmed transaction (retrying while the RPC catches up) and summarize it. */
export async function txStats(
  connection: Connection,
  signature: string,
): Promise<{ stats: TxStats; tx: VersionedTransactionResponse }> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const tx = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    if (tx?.meta && tx.blockTime != null) {
      const signatures = tx.transaction.signatures.length
      return {
        tx,
        stats: {
          signature,
          slot: tx.slot,
          blockTime: tx.blockTime,
          computeUnits: tx.meta.computeUnitsConsumed ?? 0,
          feeLamports: tx.meta.fee,
          sizeBytes: 1 + 64 * signatures + tx.transaction.message.serialize().length,
          maxInvokeDepth: maxInvokeDepth(tx.meta.logMessages ?? []),
        },
      }
    }
    await sleep(1_000)
  }
  throw new Error(`transaction ${signature} not found`)
}

/** Change in `owner`'s balance of `mint` across `tx`, in raw units. */
export function tokenDelta(
  tx: VersionedTransactionResponse,
  owner: PublicKey,
  mint: PublicKey,
): bigint {
  const pick = (balances: TokenBalance[] | null | undefined) => {
    const entry = balances?.find((b) => b.owner === owner.toBase58() && b.mint === mint.toBase58())
    return entry ? BigInt(entry.uiTokenAmount.amount) : 0n
  }
  return pick(tx.meta?.postTokenBalances) - pick(tx.meta?.preTokenBalances)
}

/** Raw token balance of `owner`'s ATA for `mint`; 0 when the ATA does not exist. */
export async function tokenBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true)
  const info = await connection.getAccountInfo(ata)
  if (!info) return 0n
  const { value } = await connection.getTokenAccountBalance(ata)
  return BigInt(value.amount)
}

/** `Clock::unix_timestamp` as the programs see it (offset 32 of the Clock sysvar). */
export async function chainUnixTime(connection: Connection): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY)
  if (!info) throw new Error('Clock sysvar not found')
  return Number(info.data.readBigInt64LE(32))
}

/** Wait (real time) until the cluster clock reaches `unixSecs`. */
export async function waitForChainTime(connection: Connection, unixSecs: number): Promise<void> {
  for (;;) {
    const now = await chainUnixTime(connection)
    if (now >= unixSecs) return
    await sleep(Math.min(10_000, Math.max(1_000, (unixSecs - now) * 500)))
  }
}
