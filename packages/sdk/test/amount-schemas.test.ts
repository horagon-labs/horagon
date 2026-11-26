import { PublicKey } from '@solana/web3.js'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { formatAmount, parseAmount } from '../src/amount'
import { HoragonError } from '../src/errors'
import {
  GamesQuerySchema,
  PubkeySchema,
  QuoteRequestSchema,
  swapDirectionFor,
} from '../src/schemas'

describe('parseAmount / formatAmount', () => {
  it.each([
    ['12.5', 12_500_000n],
    ['0', 0n],
    ['0.000001', 1n],
    ['1000', 1_000_000_000n],
    [12.5, 12_500_000n],
  ])('%s -> %s', (text, raw) => {
    expect(parseAmount(text)).toBe(raw)
  })

  it.each(['-1', '1e3', '0.0000001', '01', '1.', '', ' 1', '1000000000000', Number.NaN, 1e-7])(
    'rejects %s',
    (text) => {
      expect(() => parseAmount(text as string)).toThrow(HoragonError)
    },
  )

  it('round-trips every raw amount up to 1e18', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n - 1n }), (raw) => {
        expect(parseAmount(formatAmount(raw))).toBe(raw)
      }),
    )
  })

  it('keeps the sign of a negative P&L', () => {
    expect(formatAmount(-1_500_000n)).toBe('-1.5')
  })
})

describe('schemas', () => {
  it('accepts a PDA (off-curve) and rejects a non-canonical key', () => {
    expect(PubkeySchema.safeParse('4qXyczAr5DuBVaHUwmZT5Xt6hgQ6RwqBYcFGtrv8QEph').success).toBe(
      true,
    )
    expect(PubkeySchema.safeParse('1111111111111111111111111111111111111111111').success).toBe(
      false,
    )
  })

  it('accepts exactly the keys web3.js PublicKey accepts, without importing it (R5c)', () => {
    const web3Accepts = (v: string): boolean => {
      try {
        return new PublicKey(v).toBase58() === v
      } catch {
        return false
      }
    }
    const shape = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
    const accepts = (v: string) => PubkeySchema.safeParse(v).success
    // Every 32-byte key, on or off the curve, leading zero bytes and all.
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.nat({ max: 32 }), (b, z) => {
        b.fill(0, 0, z)
        expect(accepts(new PublicKey(b).toBase58())).toBe(true)
      }),
      { numRuns: 500 },
    )
    // Any base58 text, with a run of leading "1"s (zero bytes): the same answer as web3.js.
    const base58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
    const text = fc
      .tuple(
        fc.nat({ max: 12 }),
        fc.string({ unit: fc.constantFrom(...base58), minLength: 0, maxLength: 46 }),
      )
      .map(([ones, rest]) => '1'.repeat(ones) + rest)
    fc.assert(
      fc.property(text, (v) => {
        expect(accepts(v)).toBe(shape.test(v) && web3Accepts(v))
      }),
      { numRuns: 3_000 },
    )
    for (const v of [
      '1'.repeat(32),
      '1'.repeat(31),
      '1'.repeat(33),
      'So11111111111111111111111111111111111111112',
      `1${'4qXyczAr5DuBVaHUwmZT5Xt6hgQ6RwqBYcFGtrv8QEph'}`,
      '4qXyczAr5DuBVaHUwmZT5Xt6hgQ6RwqBYcFGtrv8QEp0',
      ' 4qXyczAr5DuBVaHUwmZT5Xt6hgQ6RwqBYcFGtrv8QEph',
      '',
    ]) {
      expect(accepts(v), v).toBe(shape.test(v) && web3Accepts(v))
    }
  })

  it('refuses a long base58 text without decoding it (R5c refix)', () => {
    // zod runs the refine even after the regex refused: the decode would grow with length².
    const long = '2'.repeat(200_000)
    const start = performance.now()
    expect(PubkeySchema.safeParse(long).success).toBe(false)
    expect(performance.now() - start).toBeLessThan(250)
  })

  it('splits a comma-separated status filter', () => {
    expect(GamesQuerySchema.parse({ status: 'live,final' }).status).toEqual(['live', 'final'])
    expect(GamesQuerySchema.safeParse({ status: 'live,soon' }).success).toBe(false)
  })

  it('rejects unknown quote fields and coerces slippage from a query string', () => {
    const base = {
      market: '4qXyczAr5DuBVaHUwmZT5Xt6hgQ6RwqBYcFGtrv8QEph',
      side: 'home',
      action: 'buy',
      amount: '10',
    }
    expect(QuoteRequestSchema.parse({ ...base, slippageBps: '150' }).slippageBps).toBe(150)
    expect(QuoteRequestSchema.safeParse({ ...base, slippageBps: '10001' }).success).toBe(false)
    expect(QuoteRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false)
  })

  it('maps side and action to the pm-AMM direction (home = YES)', () => {
    expect(swapDirectionFor('home', 'buy')).toBe('usdcToYes')
    expect(swapDirectionFor('away', 'buy')).toBe('usdcToNo')
    expect(swapDirectionFor('home', 'sell')).toBe('yesToUsdc')
    expect(swapDirectionFor('away', 'sell')).toBe('noToUsdc')
  })
})
