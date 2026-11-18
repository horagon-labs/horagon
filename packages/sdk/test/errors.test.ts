import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  DEFAULT_HINTS,
  HORAGON_ERROR_CODES,
  HoragonError,
  type HoragonErrorCode,
  isHoragonError,
} from '../src/errors'

describe('HoragonError', () => {
  it('carries a code, a default hint and the cause', () => {
    const cause = new Error('root')
    const e = new HoragonError('INSUFFICIENT_FUNDS', 'no money', { cause })
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('HoragonError')
    expect(e.code).toBe('INSUFFICIENT_FUNDS')
    expect(e.hint).toBe('Run `horagon wallet fund` to get devnet mUSDC and SOL.')
    expect(e.cause).toBe(cause)
    expect(isHoragonError(e)).toBe(true)
    expect(isHoragonError(cause)).toBe(false)
  })

  it('serializes to the API error shape', () => {
    const e = new HoragonError('PROGRAM_ERROR', 'boom', { programCode: 6015, hint: 'h' })
    expect(JSON.parse(JSON.stringify(e))).toEqual({
      code: 'PROGRAM_ERROR',
      message: 'boom',
      hint: 'h',
      programCode: 6015,
    })
  })

  it('has a non-empty default hint for every code', () => {
    for (const code of HORAGON_ERROR_CODES) expect(DEFAULT_HINTS[code].length).toBeGreaterThan(10)
  })

  it('exposes the code union as a type', () => {
    expectTypeOf<HoragonErrorCode>().toEqualTypeOf<(typeof HORAGON_ERROR_CODES)[number]>()
    expectTypeOf<'MARKET_CLOSED'>().toMatchTypeOf<HoragonErrorCode>()
  })
})
