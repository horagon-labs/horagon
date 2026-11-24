import { HoragonError } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import { errorText } from '../components/error-text'
import { errorEffect, quoteError, retryLeft } from '../lib/chrono/errors'

describe('quoteError (spec 4.4, M5)', () => {
  it('shows a network failure only after three failed polls in a row', () => {
    const lost = new HoragonError('NETWORK', 'GET /quote: no response')
    expect(quoteError({ error: lost, failures: 1 })).toBeUndefined()
    expect(quoteError({ error: lost, failures: 2 })).toBeUndefined()
    expect(quoteError({ error: lost, failures: 3 })).toBe(lost)
    const raw = new Error('fetch failed')
    expect(quoteError({ error: raw, failures: 1 })).toBeUndefined()
    expect(quoteError({ error: raw, failures: 3 })).toBe(raw)
  })

  it('shows an answer from the API at once, such as an amount too large', () => {
    const big = new HoragonError('INVALID_INPUT', 'amount exceeds the pool')
    expect(quoteError({ error: big, failures: 1 })).toBe(big)
    expect(quoteError({ error: undefined, failures: 0 })).toBeUndefined()
  })
})

describe('errorText for a live countdown (M6)', () => {
  it('leaves the seconds out while a countdown shows them', () => {
    const limited = new HoragonError('RATE_LIMITED', 'slow down', { retryAfterSecs: 4.2 })
    expect(errorText(limited)).toBe('Too many requests. Try again in 5 s.')
    expect(errorText(limited, { countdown: true })).toBe('Too many requests.')
  })
})

describe('errorEffect (spec 6.1)', () => {
  it('maps each code to what the dial does besides the words', () => {
    expect(errorEffect(new HoragonError('MARKET_CLOSED', 'closed'))).toBe('refresh')
    expect(errorEffect(new HoragonError('MARKET_HALTED', 'halted'))).toBe('refresh')
    expect(errorEffect(new HoragonError('SLIPPAGE_EXCEEDED', 'moved'))).toBe('requote')
    expect(errorEffect(new HoragonError('INSUFFICIENT_FUNDS', 'poor'))).toBe('faucet')
    const limited = new HoragonError('RATE_LIMITED', 'slow down', { retryAfterSecs: 4 })
    expect(errorEffect(limited)).toBe('countdown')
    expect(errorEffect(new HoragonError('RATE_LIMITED', 'slow down'))).toBe('text')
    expect(errorEffect(new HoragonError('PROGRAM_ERROR', 'boom'))).toBe('text')
    expect(errorEffect(new HoragonError('NETWORK', 'lost'))).toBe('text')
  })

  it('shows only words for anything else, and nothing without an error', () => {
    expect(errorEffect(new Error('raw'))).toBe('text')
    expect(errorEffect('a string')).toBe('text')
    expect(errorEffect(undefined)).toBeNull()
    expect(errorEffect(null)).toBeNull()
  })
})

describe('retryLeft (spec 6.1)', () => {
  const limited = new HoragonError('RATE_LIMITED', 'slow down', { retryAfterSecs: 4.2 })

  it('counts down from retryAfterSecs in whole seconds, to zero', () => {
    expect(retryLeft(limited, 100, 100)).toBe(5)
    expect(retryLeft(limited, 100, 102)).toBe(3)
    expect(retryLeft(limited, 100, 110)).toBe(0)
  })

  it('has nothing to wait for without retryAfterSecs', () => {
    expect(retryLeft(new HoragonError('RATE_LIMITED', 'x'), 100, 100)).toBe(0)
    expect(retryLeft(new Error('x'), 100, 100)).toBe(0)
    const nan = new HoragonError('RATE_LIMITED', 'x', { retryAfterSecs: Number.NaN })
    const inf = new HoragonError('RATE_LIMITED', 'x', { retryAfterSecs: Number.POSITIVE_INFINITY })
    expect(retryLeft(nan, 100, 100)).toBe(0)
    expect(retryLeft(inf, 100, 100)).toBe(0)
  })
})
