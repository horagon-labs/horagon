import { PublicKey } from '@solana/web3.js'
import { HoragonError } from '../errors'
import type { PoolState } from '../math/rescale'

/** sha256("account:Market")[0..8], from the pm-AMM IDL. */
export const MARKET_DISCRIMINATOR = Uint8Array.from([219, 190, 213, 55, 0, 227, 198, 154])
/** Market::LEN: 8-byte discriminator, 421 bytes of fields, 14 bytes of tail padding. */
export const MARKET_ACCOUNT_SPACE = 443
const MARKET_FIELDS_END = 429

/**
 * A decoded pm-AMM `Market` account. Fields stored as I80F48 on chain (`lZero`, reserves,
 * per-share accumulators, `totalLpShares`) keep their raw 128-bit pattern here; convert
 * them with `i80f48ToNumber`. Amounts are raw collateral units (6 decimals for mUSDC).
 */
export interface MarketAccount {
  authority: PublicKey
  marketId: bigint
  collateralMint: PublicKey
  yesMint: PublicKey
  noMint: PublicKey
  vault: PublicKey
  startTs: number
  endTs: number
  lZero: bigint
  reserveYes: bigint
  reserveNo: bigint
  lastAccrualTs: number
  cumYesPerShare: bigint
  cumNoPerShare: bigint
  totalYesDistributed: bigint
  totalNoDistributed: bigint
  totalLpShares: bigint
  resolved: boolean
  /** 0 = unresolved, 1 = YES, 2 = NO. */
  winningSide: number
  bump: number
  name: string
  initialPriceBps: number
  group: PublicKey
  unclaimedExcessYes: bigint
  unclaimedExcessNo: bigint
}

class Reader {
  private offset = 8
  private readonly view: DataView

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  pubkey(): PublicKey {
    const key = new PublicKey(this.data.subarray(this.offset, this.offset + 32))
    this.offset += 32
    return key
  }

  u8(): number {
    return this.view.getUint8(this.offset++)
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true)
    this.offset += 2
    return v
  }

  u64(): bigint {
    const v = this.view.getBigUint64(this.offset, true)
    this.offset += 8
    return v
  }

  i64(): number {
    const v = this.view.getBigInt64(this.offset, true)
    this.offset += 8
    return Number(v)
  }

  u128(): bigint {
    const lo = this.u64()
    const hi = this.u64()
    return (hi << 64n) | lo
  }

  name(length: number): string {
    const raw = this.data.subarray(this.offset, this.offset + length)
    this.offset += length
    const end = raw.indexOf(0)
    return new TextDecoder().decode(end === -1 ? raw : raw.subarray(0, end))
  }
}

export function decodeMarket(data: Uint8Array): MarketAccount {
  if (data.length < MARKET_FIELDS_END) {
    throw new HoragonError('INVALID_INPUT', `Market account too short: ${data.length} bytes`)
  }
  if (!MARKET_DISCRIMINATOR.every((b, i) => data[i] === b)) {
    throw new HoragonError('INVALID_INPUT', 'Not a pm-AMM Market account: bad discriminator')
  }
  const r = new Reader(data)
  return {
    authority: r.pubkey(),
    marketId: r.u64(),
    collateralMint: r.pubkey(),
    yesMint: r.pubkey(),
    noMint: r.pubkey(),
    vault: r.pubkey(),
    startTs: r.i64(),
    endTs: r.i64(),
    lZero: r.u128(),
    reserveYes: r.u128(),
    reserveNo: r.u128(),
    lastAccrualTs: r.i64(),
    cumYesPerShare: r.u128(),
    cumNoPerShare: r.u128(),
    totalYesDistributed: r.u64(),
    totalNoDistributed: r.u64(),
    totalLpShares: r.u128(),
    resolved: r.u8() !== 0,
    winningSide: r.u8(),
    bump: r.u8(),
    name: r.name(64),
    initialPriceBps: r.u16(),
    group: r.pubkey(),
    unclaimedExcessYes: r.u64(),
    unclaimedExcessNo: r.u64(),
  }
}

const TWO_POW_127 = 2n ** 127n
const TWO_POW_128 = 2n ** 128n
const FRACTION_MASK = 2n ** 48n - 1n

/** I80F48 raw bits (stored as u128) to a float: signed value / 2^48. */
export function i80f48ToNumber(raw: bigint): number {
  const signed = raw >= TWO_POW_127 ? raw - TWO_POW_128 : raw
  return Number(signed >> 48n) + Number(signed & FRACTION_MASK) / 2 ** 48
}

/** The curve inputs for `quoteSwap` / `rescaleReserves`. */
export function toPoolState(market: MarketAccount): PoolState {
  return {
    lZero: i80f48ToNumber(market.lZero),
    reserveYes: i80f48ToNumber(market.reserveYes),
    reserveNo: i80f48ToNumber(market.reserveNo),
    lastAccrualTs: market.lastAccrualTs,
    endTs: market.endTs,
    hasLiquidity: market.totalLpShares > 0n,
    resolved: market.resolved,
  }
}
