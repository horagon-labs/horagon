import { HoragonError } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import { errorText } from '../components/error-text'
import {
  clearedByFaucet,
  errorEffect,
  quoteError,
  requoteShown,
  retryLeft,
} from '../lib/chrono/errors'

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

describe('requoteShown (spec 6.1, M6, N1, N3)', () => {
  // Both times are the API's: `errorQuoteNow` is the now of the quote on screen at the error.
  const AT = 1_800_000_000

  it('offers a new quote until one newer than the failed send’s has come', () => {
    expect(requoteShown('requote', true, { now: AT }, AT)).toBe(true)
    expect(requoteShown('requote', true, { now: AT + 5 }, AT)).toBe(false)
    expect(requoteShown('requote', true, undefined, AT)).toBe(true)
    // No quote was on screen at the error: any quote since is newer.
    expect(requoteShown('requote', true, { now: AT }, Number.NEGATIVE_INFINITY)).toBe(false)
  })

  it('offers nothing while no quote can load, or for another error (N3)', () => {
    expect(requoteShown('requote', false, { now: AT }, AT)).toBe(false)
    expect(requoteShown('requote', false, undefined, AT)).toBe(false)
    expect(requoteShown('faucet', true, { now: AT }, AT)).toBe(false)
    expect(requoteShown(null, true, { now: AT }, AT)).toBe(false)
  })
})

describe('clearedByFaucet (I3, N6)', () => {
  it('clears only the error the faucet answers, so a failed transaction keeps its link', () => {
    expect(clearedByFaucet(new HoragonError('INSUFFICIENT_FUNDS', 'low'))).toBe(true)
    expect(clearedByFaucet(new HoragonError('PROGRAM_ERROR', 'failed'))).toBe(false)
    expect(clearedByFaucet(new HoragonError('SLIPPAGE_EXCEEDED', 'moved'))).toBe(false)
    expect(clearedByFaucet(new Error('boom'))).toBe(false)
    expect(clearedByFaucet(undefined)).toBe(false)
  })
})
