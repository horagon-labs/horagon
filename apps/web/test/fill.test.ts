import type { PositionsResponse } from '@horagon/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
  awaitFill,
  createFillTracker,
  exactFill,
  fillLine,
  type Holding,
  holding,
} from '../lib/fill'

const W = 'W'.repeat(32)
const M = 'M'.repeat(32)
const portfolio = (shares: string | null, usdcBalance: string | null): PositionsResponse =>
  ({
    wallet: W,
    usdcBalance,
    positions: shares === null ? [] : [{ market: M, side: 'home', shares }],
  }) as PositionsResponse

const h = (shares: bigint, usdc: bigint | null): Holding => ({ shares, usdc })
const quote = { quotedOut: 36_920_000n, minOut: 36_180_000n }

describe('holding', () => {
  it('reads the shares of one side and the balance; none held is 0', () => {
    expect(holding(portfolio('37.01', '63.5'), W, M, 'home')).toEqual(h(37_010_000n, 63_500_000n))
    expect(holding(portfolio(null, '63.5'), W, M, 'home')).toEqual(h(0n, 63_500_000n))
  })
  it('is unknown for another wallet or no portfolio', () => {
    expect(holding(undefined, W, M, 'home')).toBeUndefined()
    expect(holding(portfolio('1', '1'), 'other', M, 'home')).toBeUndefined()
  })
})

describe('exactFill', () => {
  const buy = { action: 'buy' as const, spent: 10_000_000n, ...quote }
  it('buy: the shares gained, when the mUSDC spent is this trade', () => {
    expect(
      exactFill({
        ...buy,
        before: h(10_000_000n, 100_000_000n),
        after: h(47_010_000n, 90_000_000n),
      }),
    ).toBe(37_010_000n)
  })
  it('sell: the mUSDC gained', () => {
    expect(
      exactFill({
        action: 'sell',
        spent: 0n,
        before: h(50_000_000n, 10_000_000n),
        after: h(13_000_000n, 46_950_000n),
        ...quote,
      }),
    ).toBe(36_950_000n)
  })
  it('is unknown until the number moved', () => {
    expect(
      exactFill({ ...buy, before: h(10n, 100_000_000n), after: h(10n, 90_000_000n) }),
    ).toBeNull()
  })
  it('is unknown for a change no single fill of this quote can explain', () => {
    expect(
      exactFill({ ...buy, before: h(0n, 100_000_000n), after: h(90_000_000n, 90_000_000n) }),
    ).toBeNull()
    expect(
      exactFill({ ...buy, before: h(0n, 100_000_000n), after: h(1_000_000n, 90_000_000n) }),
    ).toBeNull()
  })
  it('buy: is unknown when the mUSDC spent is not this trade (an earlier buy of the same size)', () => {
    // The first buy's shares are not indexed at click time; its spend already left the balance.
    // The second buy has not landed in the balance yet when the first fill's shares show up.
    expect(
      exactFill({ ...buy, before: h(0n, 100_000_000n), after: h(37_010_000n, 100_000_000n) }),
    ).toBeNull()
    expect(
      exactFill({ ...buy, before: h(0n, 100_000_000n), after: h(37_010_000n, 80_000_000n) }),
    ).toBeNull()
    expect(exactFill({ ...buy, before: h(0n, null), after: h(37_010_000n, null) })).toBeNull()
  })
  it('is unknown without a before or after, or a balance', () => {
    expect(exactFill({ ...buy, before: undefined, after: h(1n, 1n) })).toBeNull()
    expect(
      exactFill({ action: 'sell', spent: 0n, before: h(1n, null), after: h(1n, 5n), ...quote }),
    ).toBeNull()
  })
})

describe('fillTracker', () => {
  it('is busy for a market side from begin until its end, and per side', () => {
    const t = createFillTracker()
    expect(t.busy('m:home')).toBe(false)
    const end1 = t.begin('m:home')
    const end2 = t.begin('m:home')
    expect(t.busy('m:home')).toBe(true)
    expect(t.busy('m:away')).toBe(false)
    end1()
    end1()
    expect(t.busy('m:home')).toBe(true)
    end2()
    expect(t.busy('m:home')).toBe(false)
  })
})

describe('fillLine', () => {
  it('states the quote as "about" until the fill is known', () => {
    expect(fillLine('buy', 'MEM', { quoted: '36.92', exact: null })).toBe(
      'Bought about 36.92 MEM shares.',
    )
    expect(fillLine('sell', 'MEM', { quoted: '12.5', exact: null })).toBe(
      'Sold for about 12.50 mUSDC.',
    )
  })
  it('states the fill as a fact', () => {
    expect(fillLine('buy', 'MEM', { quoted: '36.92', exact: 37_010_000n })).toBe(
      'Bought 37.01 MEM shares.',
    )
    expect(fillLine('sell', 'MEM', { quoted: '12.5', exact: 12_480_000n })).toBe(
      'Sold for 12.48 mUSDC.',
    )
  })
  it('names no number when there is no quote', () => {
    expect(fillLine('buy', 'MEM', { quoted: undefined, exact: null })).toBe('Bought MEM shares.')
  })
})

describe('awaitFill', () => {
  const input = {
    action: 'buy' as const,
    spent: 10_000_000n,
    before: h(0n, 100_000_000n),
    ...quote,
  }
  it('polls until the position moves, then returns the fill', async () => {
    const loads = [h(0n, 90_000_000n), h(0n, 90_000_000n), h(37_010_000n, 90_000_000n)]
    const load = vi.fn(async () => loads.shift())
    const sleep = vi.fn(async () => {})
    expect(await awaitFill({ ...input, load, sleep, tries: 5, everyMs: 10 })).toBe(37_010_000n)
    expect(load).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })
  it('gives up after the tries, and on load errors', async () => {
    const sleep = async () => {}
    const load = vi.fn(async () => h(0n, 90_000_000n))
    expect(await awaitFill({ ...input, load, sleep, tries: 3, everyMs: 1 })).toBeNull()
    expect(load).toHaveBeenCalledTimes(3)
    const boom = async (): Promise<Holding> => {
      throw new Error('x')
    }
    expect(await awaitFill({ ...input, load: boom, sleep, tries: 2, everyMs: 1 })).toBeNull()
  })
  it('stops when told to', async () => {
    const load = vi.fn(async () => h(0n, 90_000_000n))
    let stop = false
    const sleep = async () => {
      stop = true
    }
    await awaitFill({ ...input, load, sleep, tries: 5, everyMs: 1, cancelled: () => stop })
    expect(load).toHaveBeenCalledTimes(1)
  })
})
