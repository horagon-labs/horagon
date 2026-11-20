import { decodeMarketAccount, type MarketAccount } from '@horagon/sdk'
import type { AccountInfo, Connection, PublicKey } from '@solana/web3.js'
import { ApiError } from './problem'

/** Wraps an RPC call: any transport failure becomes NETWORK without leaking the RPC URL. */
export async function rpc<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (cause) {
    if (cause instanceof ApiError) throw cause
    throw new ApiError('NETWORK', `RPC call failed: ${what}`, { status: 502 })
  }
}

/** SPL token account `amount` (u64 LE at byte 64), or 0n for a missing account. */
export function tokenAmount(info: AccountInfo<Buffer> | null): bigint {
  if (!info || info.data.length < 72) return 0n
  return info.data.readBigUInt64LE(64)
}

interface Cached<T> {
  at: number
  value: T
}

/**
 * The API's only path to the chain. Market accounts are cached for `ttlMs` (1 s): clients
 * poll every 3 s and a quote needs the reserves of this second, not this millisecond.
 */
export class ChainReader {
  private readonly markets = new Map<string, Cached<MarketAccount>>()
  private hash: Cached<{ blockhash: string; lastValidBlockHeight: number }> | undefined

  constructor(
    readonly connection: Connection,
    private readonly ttlMs = 1_000,
  ) {}

  async market(pubkey: PublicKey): Promise<MarketAccount> {
    const key = pubkey.toBase58()
    const hit = this.markets.get(key)
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value
    const info = await rpc('getAccountInfo', () =>
      this.connection.getAccountInfo(pubkey, 'confirmed'),
    )
    if (!info) throw new ApiError('NOT_FOUND', `Market ${key} does not exist on chain`)
    const value = decodeMarketAccount(info)
    this.markets.set(key, { at: Date.now(), value })
    return value
  }

  async accounts(keys: PublicKey[]): Promise<Array<AccountInfo<Buffer> | null>> {
    if (keys.length === 0) return []
    return rpc('getMultipleAccountsInfo', () =>
      this.connection.getMultipleAccountsInfo(keys, 'confirmed'),
    )
  }

  /** A blockhash at most 10 s old: valid for ~60 s more, which `expiresAt` reports. */
  async blockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    if (this.hash && Date.now() - this.hash.at < 10_000) return this.hash.value
    const value = await rpc('getLatestBlockhash', () =>
      this.connection.getLatestBlockhash('confirmed'),
    )
    this.hash = { at: Date.now(), value }
    return value
  }
}
