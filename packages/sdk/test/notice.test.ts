import { describe, expect, it } from 'vitest'
import { PLAY_MONEY_NOTICE } from '../src'

describe('PLAY_MONEY_NOTICE', () => {
  it('is the banner line, word for word (spec 2.7, 12)', () => {
    expect(PLAY_MONEY_NOTICE).toBe('Play-money on devnet. No real value. No prizes.')
  })
})
