import { describe, expect, it } from 'vitest'
import { checkTrade, type TradeFormInput } from '../lib/trade-form'

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
    expect(check({ marketStatus: 'proposed' })).toMatchObject({ ok: false, reason: /closed/ })
    expect(check({ nowSecs: 2_000 })).toMatchObject({ ok: false, quote: false, reason: /closed/ })
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
