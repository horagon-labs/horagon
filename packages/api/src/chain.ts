import { decodeMarketAccount, isHoragonError, type MarketAccount } from '@horagon/sdk'
import type { AccountInfo, Connection, PublicKey } from '@solana/web3.js'
import { ApiError } from './problem'

/** `getMultipleAccounts` takes at most 100 keys per call. */
export const MAX_KEYS_PER_CALL = 100

/** What a client can do when the server, not the client, could not reach Solana. */
export const RPC_DOWN_HINT = 'The server could not reach Solana; retry in a few seconds.'

/**
 * Wraps an RPC call: a transport failure becomes NETWORK without leaking the RPC URL to the
 * client. The original error stays on the ApiError as `cause`, for the logs only (the app logs
 * `errorSummary(cause)`, which redacts URLs). ApiErrors and HoragonErrors pass through as they are.
 */
export async function rpc<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (cause) {
    if (cause instanceof ApiError || isHoragonError(cause)) throw cause
    throw new ApiError('NETWORK', `RPC call failed: ${what}`, {
      status: 502,
      hint: RPC_DOWN_HINT,
      cause,
    })
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
 * Simultaneous misses for one market share a single `getAccountInfo`.
 */
export class ChainReader {
  private readonly markets = new Map<string, Cached<MarketAccount>>()
  private readonly pending = new Map<string, Promise<MarketAccount>>()
  private hash: Cached<{ blockhash: string; lastValidBlockHeight: number }> | undefined

  constructor(
    readonly connection: Connection,
    private readonly ttlMs = 1_000,
  ) {}

  async market(pubkey: PublicKey): Promise<MarketAccount> {
    const key = pubkey.toBase58()
    const hit = this.markets.get(key)
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value
    const inFlight = this.pending.get(key)
    if (inFlight) return inFlight
    const load = (async () => {
      const info = await rpc('getAccountInfo', () =>
        this.connection.getAccountInfo(pubkey, 'confirmed'),
      )
      if (!info) throw new ApiError('NOT_FOUND', `Market ${key} does not exist on chain`)
      const value = decodeMarketAccount(info)
      this.markets.set(key, { at: Date.now(), value })
      return value
    })()
    this.pending.set(key, load)
    try {
      return await load
    } finally {
      // Resolved: the cache holds it. Rejected: the next caller tries again.
      this.pending.delete(key)
    }
  }

  /** Every key's account in input order, in slices of at most 100 keys per RPC call. */
  async accounts(keys: PublicKey[]): Promise<Array<AccountInfo<Buffer> | null>> {
    if (keys.length === 0) return []
    const slices: PublicKey[][] = []
    for (let i = 0; i < keys.length; i += MAX_KEYS_PER_CALL) {
      slices.push(keys.slice(i, i + MAX_KEYS_PER_CALL))
    }
    const results = await Promise.all(
      slices.map((slice) =>
        rpc('getMultipleAccountsInfo', () =>
          this.connection.getMultipleAccountsInfo(slice, 'confirmed'),
        ),
      ),
    )
    return results.flat()
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
