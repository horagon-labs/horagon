import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { HoragonError } from '../../src/errors'
import { quoteSwap } from '../../src/math/quote'
import { rescaleReserves } from '../../src/math/rescale'
import {
  decodeMarket,
  i80f48ToNumber,
  MARKET_ACCOUNT_SPACE,
  type MarketAccount,
  toPoolState,
} from '../../src/pm-amm/market'
import { deriveMarketPda, deriveNoMint, deriveVault, deriveYesMint } from '../../src/pm-amm/pda'

interface Fixture {
  pubkey: string
  slot: number
  dataBase64: string
  expected: Record<string, string | number | boolean>
}

// A real devnet market, fetched with getProgramAccounts at `slot`. `expected` was decoded
// independently in Python (struct.unpack over the IDL field order).
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/market-devnet.json', import.meta.url), 'utf8'),
) as Fixture
const data = Uint8Array.from(Buffer.from(fixture.dataBase64, 'base64'))

function asPlain(m: MarketAccount): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(m).map(([k, v]) => [
      k,
      v instanceof PublicKey ? v.toBase58() : typeof v === 'bigint' ? v.toString() : v,
    ]),
  )
}

describe('decodeMarket', () => {
  it('decodes the devnet fixture exactly like the independent Python decoder', () => {
    expect(data).toHaveLength(MARKET_ACCOUNT_SPACE)
    const { pubkey: _pubkey, ...expected } = fixture.expected
    expect(asPlain(decodeMarket(data))).toEqual(expected)
  })

  it('agrees with the pm-AMM PDA seeds', () => {
    const m = decodeMarket(data)
    const market = deriveMarketPda(m.marketId)
    expect(market.toBase58()).toBe(fixture.pubkey)
    expect(deriveYesMint(market).equals(m.yesMint)).toBe(true)
    expect(deriveNoMint(market).equals(m.noMint)).toBe(true)
    expect(deriveVault(market).equals(m.vault)).toBe(true)
  })

  it('rejects a short buffer and a wrong discriminator', () => {
    expect(() => decodeMarket(data.subarray(0, 100))).toThrow(HoragonError)
    const wrong = Uint8Array.from(data)
    wrong[0] = 0
    expect(() => decodeMarket(wrong)).toThrow(/discriminator/)
  })
})

describe('i80f48ToNumber', () => {
  it.each([
    [0n, 0],
    [1n << 48n, 1],
    [3n << 47n, 1.5],
    [2n ** 128n - (1n << 48n), -1],
  ])('%s -> %d', (raw, value) => {
    expect(i80f48ToNumber(raw)).toBe(value)
  })
})

describe('toPoolState', () => {
  it('turns the fixture into curve inputs that quote cleanly', () => {
    const m = decodeMarket(data)
    const pool = toPoolState(m)
    expect(pool.lZero).toBeCloseTo(26994.792068849743, 6)
    expect(pool.reserveYes).toBeCloseTo(32437269.46203044, 4)
    expect(pool.reserveNo).toBeCloseTo(44080004.03329939, 4)
    expect(pool.hasLiquidity).toBe(true)

    const now = m.lastAccrualTs + 3600
    const r = rescaleReserves(pool, now)
    expect(r.x).toBeLessThan(pool.reserveYes)
    const q = quoteSwap({ pool, direction: 'usdcToYes', amountIn: 1_000_000n, now })
    expect(q.amountOut).toBeGreaterThan(1_000_000n)
    expect(q.priceAfter).toBeGreaterThan(q.priceBefore)
  })
})
