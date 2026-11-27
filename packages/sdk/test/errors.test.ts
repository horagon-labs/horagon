import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  DEFAULT_HINTS,
  errorSummary,
  HORAGON_ERROR_CODES,
  HoragonError,
  type HoragonErrorCode,
  isHoragonError,
  redactUrls,
} from '../src/errors'

describe('HoragonError', () => {
  it('carries a code, a default hint and the cause', () => {
    const cause = new Error('root')
    const e = new HoragonError('INSUFFICIENT_FUNDS', 'no money', { cause })
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('HoragonError')
    expect(e.code).toBe('INSUFFICIENT_FUNDS')
    expect(e.hint).toBe(
      'Get devnet mUSDC from the faucet, then retry; a sponsored trade needs no SOL.',
    )
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

  // Horagon ships no player CLI (README, Status: "Not planned"), and its only domain is
  // horagon.xyz: a hint names the site, an API v1 route or an SDK method, nothing else.
  it('names no command line tool and no other domain in any default hint', () => {
    for (const code of HORAGON_ERROR_CODES) {
      const hint = DEFAULT_HINTS[code]
      expect(hint, code).not.toMatch(/\bhoragon (games|wallet|debug)\b|\bhg\.|horagon\.com|`/)
    }
    expect(DEFAULT_HINTS.NOT_FOUND).toBe(
      'Check the id or the path. Game ids are listed by GET /api/v1/games.',
    )
    expect(DEFAULT_HINTS.PROGRAM_ERROR).toBe(
      'Look the transaction up with GET /api/v1/tx/<signature>, or on Solana Explorer (devnet).',
    )
  })

  it('exposes the code union as a type', () => {
    expectTypeOf<HoragonErrorCode>().toEqualTypeOf<(typeof HORAGON_ERROR_CODES)[number]>()
    expectTypeOf<'MARKET_CLOSED'>().toMatchTypeOf<HoragonErrorCode>()
  })
})

describe('errorSummary', () => {
  it('keeps the name and message but never the stack or a keyed URL', () => {
    const err = new Error(
      'fetch failed: https://devnet.helius-rpc.com/?api-key=K3Y and wss://rpc.example/ws?token=T0K',
    )
    const s = errorSummary(err)
    expect(s.name).toBe('Error')
    expect(s.message).toContain('https://devnet.helius-rpc.com/…')
    expect(JSON.stringify(s)).not.toMatch(/K3Y|T0K|stack|at /)
  })

  it('reads codes and non-Error values', () => {
    expect(errorSummary(new HoragonError('NETWORK', 'down')).code).toBe('NETWORK')
    expect(errorSummary({ InstructionError: [0, { Custom: 6004 }] }).message).toContain('6004')
    expect(errorSummary('api_key=abc&x=1').message).toBe('api_key=…&x=1')
  })
})

describe('redactUrls userinfo', () => {
  it('drops user:pass@ and keeps only the host', () => {
    expect(redactUrls('https://user:s3cret@rpc.example.com/v1?x=1')).toBe(
      'https://rpc.example.com/…',
    )
    expect(redactUrls('wss://tok@rpc.example.com:8900/ws')).toBe('wss://rpc.example.com:8900/…')
  })

  it('drops userinfo up to the last @ before the path', () => {
    expect(redactUrls('https://user:p@ss@rpc.example.com/v1')).toBe('https://rpc.example.com/…')
  })

  it('does not mistake an @ in the path or query for userinfo', () => {
    expect(redactUrls('https://rpc.example.com/v1?q=a@b')).toBe('https://rpc.example.com/…')
    expect(redactUrls('https://h/path@x')).toBe('https://h/…')
  })

  it('keeps the password out of an error summary', () => {
    const s = errorSummary(new Error('fetch failed: https://user:s3cret@rpc.example.com/v1'))
    expect(s.message).toContain('https://rpc.example.com/…')
    expect(JSON.stringify(s)).not.toMatch(/s3cret|user:/)
  })
})
