// liveMarket: what the API's market state and the keeper's price points read (Task 6).
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { liveMarket } from '../../src/pm-amm/live'
import type { MarketAccount } from '../../src/pm-amm/market'

const NOW = 1_800_000_000
const I80F48_ONE = 1n << 48n
const key = () => Keypair.generate().publicKey
/** 100 mUSDC per side at P = 0.5 with one hour left (I80F48 fixed point, as on chain). */
const MARKET: MarketAccount = {
  authority: key(),
  marketId: 1n,
  collateralMint: key(),
  yesMint: key(),
  noMint: key(),
  vault: key(),
  startTs: NOW - 600,
  endTs: NOW + 3600,
  lZero: 4_177_713n * I80F48_ONE,
  reserveYes: 100_000_000n * I80F48_ONE,
  reserveNo: 100_000_000n * I80F48_ONE,
  lastAccrualTs: NOW,
  cumYesPerShare: 0n,
  cumNoPerShare: 0n,
  totalYesDistributed: 0n,
  totalNoDistributed: 0n,
  totalLpShares: 1_000n,
  resolved: false,
  winningSide: 0,
  bump: 255,
  name: 'test',
  initialPriceBps: 5_000,
  group: key(),
  unclaimedExcessYes: 0n,
  unclaimedExcessNo: 0n,
}

describe('liveMarket', () => {
  it('prices a centred pool at 0.5, and L_eff shrinks as time passes', () => {
    const now = liveMarket(MARKET, NOW)
    expect(now.price).toBeCloseTo(0.5, 6)
    expect(now.closed).toBe(false)
    expect(liveMarket(MARKET, NOW + 600).liquidity).toBeLessThan(now.liquidity)
  })

  it('gives the same state for a clock behind the last accrual (effectiveTime)', () => {
    expect(liveMarket(MARKET, NOW - 30)).toEqual(liveMarket(MARKET, NOW))
  })

  it('has no price at end_ts, nor for a pool without liquidity', () => {
    expect(liveMarket(MARKET, MARKET.endTs)).toEqual({ price: null, liquidity: 0, closed: true })
    expect(liveMarket({ ...MARKET, totalLpShares: 0n }, NOW)).toEqual({
      price: null,
      liquidity: 0,
      closed: false,
    })
  })

  it('reports the winning side once resolved', () => {
    expect(liveMarket({ ...MARKET, resolved: true, winningSide: 1 }, NOW).price).toBe(1)
    expect(liveMarket({ ...MARKET, resolved: true, winningSide: 2 }, NOW).price).toBe(0)
  })
})
