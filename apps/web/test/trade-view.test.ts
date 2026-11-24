import type { Quote } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import {
  freshQuote,
  keepQuote,
  quoteKey,
  sendDisabled,
  sendText,
  sidePrice,
} from '../lib/trade-view'

describe('trade view (Chronometer spec 3.3)', () => {
  it('prices home at YES and away at NO', () => {
    expect(sidePrice(0.77, 'home')).toBe(0.77)
    expect(sidePrice(0.77, 'away')).toBeCloseTo(0.23, 10)
    expect(sidePrice(null, 'away')).toBeNull()
  })

  it('keys a quote by market, side, direction and amount, and asks none without an amount', () => {
    expect(quoteKey('Mkt', 'home', 'buy', '10')).toBe('quote:Mkt:home:buy:10')
    expect(quoteKey('Mkt', 'away', 'sell', null)).toBeNull()
  })

  it('says what the send button does at each step', () => {
    expect(sendText('no-wallet', null, 'buy', 'CLE')).toBe('Set up wallet to trade')
    expect(sendText('loading', null, 'buy', 'CLE')).toBe('Loading your balance…')
    expect(sendText('ready', 'confirming', 'buy', 'CLE')).toBe('Confirming…')
    expect(sendText('ready', null, 'buy', 'CLE')).toBe('Buy CLE')
    expect(sendText('ready', null, 'sell', 'MEM')).toBe('Sell MEM')
  })

  it('waits for the balance and for a valid form, and lets a wallet be set up', () => {
    expect(sendDisabled('loading', true, null)).toBe(true)
    expect(sendDisabled('ready', false, null)).toBe(true)
    expect(sendDisabled('ready', true, 'signing')).toBe(true)
    expect(sendDisabled('ready', true, null)).toBe(false)
    expect(sendDisabled('no-wallet', false, null)).toBe(false)
  })
})

const q = (n: string) => ({ amountOut: n }) as unknown as Quote

describe('freshQuote and keepQuote (the ghost never shows another side)', () => {
  it('gives a quote only for the key it was loaded for', () => {
    const data = { key: 'k1', quote: q('1') }
    expect(freshQuote(data, 'k1')).toBe(data.quote)
    expect(freshQuote(data, 'k2')).toBeUndefined()
    expect(freshQuote(data, null)).toBeUndefined()
    expect(freshQuote(undefined, 'k1')).toBeUndefined()
  })

  it('keeps the last quote for the same side and direction only', () => {
    const prev = { side: 'home' as const, action: 'buy' as const, quote: q('1') }
    expect(keepQuote(prev, undefined, 'home', 'buy', 'k')).toBe(prev)
    expect(keepQuote(prev, undefined, 'away', 'buy', 'k')).toBeUndefined()
    expect(keepQuote(prev, undefined, 'home', 'sell', 'k')).toBeUndefined()
    expect(keepQuote(prev, undefined, 'home', 'buy', null)).toBeUndefined()
    expect(keepQuote(undefined, undefined, 'home', 'buy', 'k')).toBeUndefined()
  })

  it('takes a fresh quote, and returns the same object when it did not change', () => {
    const prev = { side: 'home' as const, action: 'buy' as const, quote: q('1') }
    const next = q('2')
    expect(keepQuote(prev, next, 'home', 'buy', 'k')?.quote).toBe(next)
    expect(keepQuote(prev, prev.quote, 'home', 'buy', 'k')).toBe(prev)
    expect(keepQuote(prev, next, 'away', 'buy', 'k')).toEqual({
      side: 'away',
      action: 'buy',
      quote: next,
    })
  })
})
