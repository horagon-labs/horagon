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
