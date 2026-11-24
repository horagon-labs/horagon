import { describe, expect, it } from 'vitest'
import { quoteKey, sendDisabled, sendText, sidePrice } from '../lib/trade-view'

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
