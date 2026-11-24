import { HoragonError } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import { errorEffect, retryLeft } from '../lib/chrono/errors'

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
