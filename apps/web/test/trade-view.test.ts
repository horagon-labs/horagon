import type { Quote } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import { market, position } from '../lib/chrono/fixtures'
import {
  BUY_AMOUNT,
  freshQuote,
  heldOn,
  keepQuote,
  quoteKey,
  sendDisabled,
  sendText,
  sidePrice,
  startAmount,
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
    expect(sendText('no-wallet', null, 'buy', 'CLE')).toBe('Get 1,000 play mUSDC to start')
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

describe('startAmount (one rule per direction, Task 18 ruling)', () => {
  const buying = { action: 'buy' as const, side: 'home' as const, amount: '25' }
  const selling = { action: 'sell' as const, side: 'home' as const, amount: '7.05' }

  it('starts a buy from BUY_AMOUNT, never from a share count (the pick() reset)', () => {
    expect(BUY_AMOUNT).toBe('10')
    expect(startAmount({ action: 'buy', side: 'home' }, selling, '14.1')).toBe('10')
    expect(startAmount({ action: 'buy', side: 'away' }, selling, undefined)).toBe('10')
  })

  it('starts a sell from every share held, or nothing when none are held', () => {
    expect(startAmount({ action: 'sell', side: 'home' }, buying, '14.1')).toBe('14.1')
    expect(startAmount({ action: 'sell', side: 'home' }, buying, undefined)).toBe('')
    expect(startAmount({ action: 'sell', side: 'away' }, selling, '3')).toBe('3')
  })

  it('keeps the amount while the direction stays, and a sell’s while its side stays', () => {
    expect(startAmount({ action: 'buy', side: 'home' }, buying, '14.1')).toBe('25')
    expect(startAmount({ action: 'buy', side: 'away' }, buying, undefined)).toBe('25')
    expect(startAmount({ action: 'sell', side: 'home' }, selling, '14.1')).toBe('7.05')
  })
})

describe('heldOn (spec 3.2)', () => {
  const MKT = market().pubkey

  it('finds the position on one side of the market while it holds shares', () => {
    const home = position({ market: MKT })
    expect(heldOn([home], MKT, 'home')).toBe(home)
    expect(heldOn([home], MKT, 'away')).toBeUndefined()
    expect(heldOn([home], `${MKT.slice(0, -1)}2`, 'home')).toBeUndefined()
    expect(heldOn(undefined, MKT, 'home')).toBeUndefined()
  })

  it('counts a position sold down to zero shares as none held (M11)', () => {
    expect(heldOn([position({ market: MKT, shares: '0' })], MKT, 'home')).toBeUndefined()
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
