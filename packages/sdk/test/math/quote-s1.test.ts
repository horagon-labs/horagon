import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SWAP_DIRECTIONS, type SwapDirection } from '../../src/math/curve'
import { quoteSwap } from '../../src/math/quote'
import { decodeMarket, toPoolState } from '../../src/pm-amm/market'

interface RecordedSwap {
  direction: SwapDirection
  amountIn: string
  now: number
  marketDataBase64: string
  actualOut: string
  signature: string
}

const FIXTURE = new URL('../fixtures/s1-swaps.json', import.meta.url)
const swaps: RecordedSwap[] = existsSync(FIXTURE)
  ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { swaps: RecordedSwap[] }).swaps
  : []

// Spike S1 records six real devnet swaps (Task 12). Until then this suite is skipped.
describe.skipIf(swaps.length === 0)('quoteSwap against devnet swaps recorded by spike S1', () => {
  it('covers every swap direction', () => {
    expect(new Set(swaps.map((s) => s.direction))).toEqual(new Set(SWAP_DIRECTIONS))
  })

  it.each(swaps.map((s) => [s.direction, s] as const))(
    '%s matches the chain within 0.1%%',
    (_d, s) => {
      const pool = toPoolState(decodeMarket(Buffer.from(s.marketDataBase64, 'base64')))
      const quote = quoteSwap({
        pool,
        direction: s.direction,
        amountIn: BigInt(s.amountIn),
        now: s.now,
      })
      const actual = Number(s.actualOut)
      expect(actual).toBeGreaterThan(0)
      expect(Math.abs(Number(quote.amountOut) - actual) / actual).toBeLessThan(0.001)
    },
  )
})
