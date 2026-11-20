// Tier 0 review findings fixed at the start of Tier 1 (ledger: Tasks 5, 6, 8 and 9 Minors).
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { HoragonError, isHoragonError } from '../src/errors'
import { effectiveTime } from '../src/math/rescale'
import { eloProbability } from '../src/model/elo'
import { winProbability } from '../src/model/win-probability'
import { PM_AMM_PROGRAM_ID } from '../src/pm-amm/constants'
import { fromProgramError } from '../src/pm-amm/errors'
import { decodeMarketAccount, MARKET_ACCOUNT_SPACE } from '../src/pm-amm/market'

const NOW = 1_800_000_000

describe('isHoragonError across SDK copies', () => {
  it('accepts an error from another build of the class', () => {
    // What the CJS build's HoragonError looks like to code that imported the ESM build.
    class HoragonError extends Error {
      readonly code = 'NETWORK'
      constructor() {
        super('x')
        this.name = 'HoragonError'
      }
    }
    expect(isHoragonError(new HoragonError())).toBe(true)
  })

  it('rejects look-alikes without a known code', () => {
    const fake = Object.assign(new Error('x'), { name: 'HoragonError', code: 'NOPE' })
    expect(isHoragonError(fake)).toBe(false)
    expect(isHoragonError({ name: 'HoragonError', code: 'NETWORK' })).toBe(false)
  })
})

describe('fromProgramError on non-Error values and odd logs', () => {
  it('reads a confirmTransaction error object', () => {
    const err = fromProgramError({ InstructionError: [2, { Custom: 6007 }] })
    expect(err.code).toBe('SLIPPAGE_EXCEEDED')
    expect(err.programCode).toBe(6007)
  })

  it('reads the Rust Custom(n) form', () => {
    const err = fromProgramError(new Error('InstructionError(1, Custom(6001))'))
    expect(err.code).toBe('PROGRAM_ERROR')
    expect(err.message).toContain('MarketNotResolved')
  })

  it('lets a program code win over a stray 429 in the logs', () => {
    const err = Object.assign(new Error('Simulation failed'), {
      logs: ['Program log: amount 429', 'custom program error: 0x1777'],
    })
    expect(fromProgramError(err).code).toBe('SLIPPAGE_EXCEEDED')
  })

  it('maps 3012 from claim_lp_residuals to NOT_FOUND, not a missing token account', () => {
    const raw = new Error('custom program error: 0xbc4')
    expect(fromProgramError(raw).code).toBe('MISSING_TOKEN_ACCOUNT')
    const claim = fromProgramError(raw, { instruction: 'claimLpResiduals' })
    expect(claim.code).toBe('NOT_FOUND')
    expect(claim.programCode).toBe(3012)
  })

  it('maps 6004 to MARKET_HALTED only for a swap', () => {
    const err = { err: { InstructionError: [1, { Custom: 6004 }] }, logs: [] }
    expect(fromProgramError(err).code).toBe('MARKET_HALTED')
    expect(fromProgramError(err, { instruction: 'swap' }).code).toBe('MARKET_HALTED')
    const withdraw = fromProgramError(err, { instruction: 'withdrawLiquidity' })
    expect(withdraw.code).toBe('PROGRAM_ERROR')
    expect(withdraw.programCode).toBe(6004)
  })
})

describe('decodeMarketAccount', () => {
  it('refuses an account pm-AMM does not own', () => {
    const info = { owner: Keypair.generate().publicKey, data: new Uint8Array(MARKET_ACCOUNT_SPACE) }
    expect(() => decodeMarketAccount(info)).toThrow(/Not a pm-AMM account/)
  })

  it('checks the discriminator once the owner is right', () => {
    const info = { owner: PM_AMM_PROGRAM_ID, data: new Uint8Array(MARKET_ACCOUNT_SPACE) }
    expect(() => decodeMarketAccount(info)).toThrow(/bad discriminator/)
  })
})

describe('effectiveTime', () => {
  it('never runs before the last accrual, and floors a fractional clock', () => {
    expect(effectiveTime(NOW - 30, NOW)).toBe(NOW)
    expect(effectiveTime(NOW + 12.9, NOW)).toBe(NOW + 12)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('rejects now = %s', (now) => {
    expect(() => effectiveTime(now, NOW)).toThrow(HoragonError)
  })
})

describe('model inputs', () => {
  const base = { margin: 3, minutesRemaining: 12, p0: 0.6, sigma: 12 }

  it.each([
    { minutesRemaining: Number.POSITIVE_INFINITY },
    { minutesRemaining: 49 },
    { sigma: Number.POSITIVE_INFINITY },
    { sigma: Number.NaN },
  ])('winProbability rejects %o', (patch) => {
    expect(() => winProbability({ ...base, ...patch })).toThrow(/INVALID_INPUT|must be/)
  })

  it('eloProbability rejects NaN ratings', () => {
    expect(() => eloProbability(Number.NaN, 1500)).toThrow(HoragonError)
  })
})
