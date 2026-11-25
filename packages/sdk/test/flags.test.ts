import { describe, expect, it } from 'vitest'
import { FlagsResponseSchema } from '../src/schemas'

const off = {
  FLAG_ME: false,
  FLAG_METRICS: false,
  FLAG_METRICS_COHORT: false,
  FLAG_SHARE: false,
  FLAG_RANK: false,
  FLAG_CREWS: false,
  FLAG_TELEGRAM: false,
  FLAG_CLUTCH: false,
  FLAG_PRACTICE: false,
  FLAG_VERIFY: false,
}

describe('FlagsResponseSchema', () => {
  it('takes the ten flags of spec 3.3', () => {
    expect(FlagsResponseSchema.parse({ flags: { ...off, FLAG_ME: true } })).toEqual({
      flags: { ...off, FLAG_ME: true },
    })
  })

  it('refuses a missing, unknown or non-boolean flag', () => {
    const { FLAG_ME: _gone, ...missing } = off
    expect(FlagsResponseSchema.safeParse({ flags: missing }).success).toBe(false)
    expect(FlagsResponseSchema.safeParse({ flags: { ...off, FLAG_GONE: true } }).success).toBe(
      false,
    )
    expect(FlagsResponseSchema.safeParse({ flags: { ...off, FLAG_ME: 'on' } }).success).toBe(false)
  })
})
