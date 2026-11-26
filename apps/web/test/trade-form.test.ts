import { describe, expect, it } from 'vitest'
import { checkTrade, type TradeFormInput, tradeReady } from '../lib/trade-form'

const base: TradeFormInput = {
  action: 'buy',
  amount: '10',
  balance: '100',
  shares: undefined,
  marketStatus: 'open',
  endTs: 2_000,
  nowSecs: 1_000,
}
const check = (over: Partial<TradeFormInput>) => checkTrade({ ...base, ...over })

describe('checkTrade', () => {
  it('allows a normal buy and a sell within the position', () => {
    expect(check({})).toEqual({ ok: true, quote: true })
    expect(check({ action: 'sell', amount: '5.5', shares: '38.721969' })).toEqual({
      ok: true,
      quote: true,
    })
  })

  it('blocks a halted, resolved or expired market without quoting', () => {
    expect(check({ marketStatus: 'halted' })).toMatchObject({
      ok: false,
      quote: false,
      reason: /halted/,
    })
    expect(check({ marketStatus: 'halted', gameStatus: 'live' })).toMatchObject({
      reason: /halted/,
    })
    expect(check({ marketStatus: 'proposed' })).toMatchObject({ ok: false, reason: /closed/ })
    expect(check({ nowSecs: 2_000 })).toMatchObject({ ok: false, quote: false, reason: /closed/ })
  })

  it('says a halt under a final game is the close at the final buzzer (R1), not a halt', () => {
    expect(check({ marketStatus: 'halted', gameStatus: 'final' })).toEqual({
      ok: false,
      quote: false,
      reason: 'Trading closed at the final buzzer.',
    })
  })

  it('rejects amounts that are not plain decimals with at most 6 places', () => {
    for (const amount of ['', ' ', 'abc', '-1', '1e3', '1.1234567', '01', '1,5']) {
      expect(check({ amount })).toMatchObject({ ok: false, quote: false })
    }
    expect(check({ amount: '0' })).toMatchObject({ ok: false, reason: /above 0/ })
    expect(check({ amount: ' 12.5 ' }).ok).toBe(true)
  })

  it('points at the faucet when the balance is short, but still quotes', () => {
    expect(check({ amount: '100.000001' })).toEqual({
      ok: false,
      quote: true,
      reason: 'Not enough mUSDC.',
      fund: true,
    })
    expect(check({ amount: '100' }).ok).toBe(true)
  })

  it('leaves the balance check to the API while the balance is unknown', () => {
    expect(check({ amount: '5000', balance: null }).ok).toBe(true)
    expect(check({ amount: '5000', balance: undefined }).ok).toBe(true)
  })

  it('does not sell more than the position', () => {
    expect(check({ action: 'sell', amount: '1' })).toMatchObject({
      ok: false,
      quote: false,
      reason: /no shares/,
    })
    expect(check({ action: 'sell', amount: '40', shares: '38.721969' })).toMatchObject({
      ok: false,
      quote: true,
      reason: 'You hold 38.721969 shares.',
    })
  })
})

describe('tradeReady (fix M3)', () => {
  const ME = 'Me1111111111111111111111111111111111111111'
  const OTHER = 'Ot1111111111111111111111111111111111111111'

  it('has no wallet to trade with before the gate created one', () => {
    expect(tradeReady(null, undefined)).toBe('no-wallet')
    expect(tradeReady(null, { wallet: ME })).toBe('no-wallet')
  })

  it('waits for this signer’s portfolio to load once', () => {
    expect(tradeReady(ME, undefined)).toBe('loading')
    expect(tradeReady(ME, { wallet: OTHER })).toBe('loading')
  })

  it('is ready once this signer’s portfolio has loaded', () => {
    expect(tradeReady(ME, { wallet: ME })).toBe('ready')
  })
})
