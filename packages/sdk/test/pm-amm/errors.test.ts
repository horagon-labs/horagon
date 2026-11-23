import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HoragonError } from '../../src/errors'
import {
  extractProgramErrorCode,
  fromProgramError,
  PM_AMM_ERROR_NAMES,
} from '../../src/pm-amm/errors'

describe('PM_AMM_ERROR_NAMES', () => {
  it('matches the vendored IDL', () => {
    const idl = JSON.parse(
      readFileSync(new URL('../../vendor/pm-amm/src/idl/pm_amm.json', import.meta.url), 'utf8'),
    ) as { errors: Array<{ code: number; name: string }> }
    const fromIdl = new Map(idl.errors.map((e) => [e.code, e.name]))
    for (const [code, name] of Object.entries(PM_AMM_ERROR_NAMES)) {
      expect(fromIdl.get(Number(code)), `code ${code}`).toBe(name)
    }
  })
})

describe('extractProgramErrorCode', () => {
  it.each([
    ['Transaction simulation failed: custom program error: 0x1777', 6007],
    ['{"InstructionError":[2,{"Custom":6004}]}', 6004],
    ['Program log: AnchorError ... Error Number: 3012. Error Message: ...', 3012],
    ['blockhash not found', undefined],
  ])('%s -> %s', (text, code) => {
    expect(extractProgramErrorCode(text)).toBe(code)
  })
})

describe('fromProgramError', () => {
  it.each([
    ['custom program error: 0x1777', 'SLIPPAGE_EXCEEDED', 6007],
    ['custom program error: 0x1774', 'MARKET_HALTED', 6004],
    ['custom program error: 0x1772', 'MARKET_CLOSED', 6002],
    ['custom program error: 0x1770', 'MARKET_CLOSED', 6000],
    ['custom program error: 0xbc4', 'MISSING_TOKEN_ACCOUNT', 3012],
    ['custom program error: 0x1776', 'INSUFFICIENT_FUNDS', 6006],
    ['custom program error: 0x177f', 'PROGRAM_ERROR', 6015],
  ])('maps "%s" to %s', (message, code, programCode) => {
    const e = fromProgramError(new Error(message))
    expect(e.code).toBe(code)
    expect(e.programCode).toBe(programCode)
    expect(e.hint.length).toBeGreaterThan(0)
  })

  it('reads the code from simulation logs', () => {
    const err = Object.assign(new Error('Simulation failed'), {
      logs: ['Program GV1F... failed: custom program error: 0x1777'],
    })
    expect(fromProgramError(err).code).toBe('SLIPPAGE_EXCEEDED')
  })

  it('treats an SPL Token insufficient-funds failure as INSUFFICIENT_FUNDS', () => {
    const err = Object.assign(new Error('failed: custom program error: 0x1'), {
      logs: ['Program log: Error: insufficient funds'],
    })
    expect(fromProgramError(err).code).toBe('INSUFFICIENT_FUNDS')
  })

  it('treats a fee payer with no SOL as INSUFFICIENT_FUNDS', () => {
    const err = new Error('Attempt to debit an account but found no record of a prior credit.')
    expect(fromProgramError(err).code).toBe('INSUFFICIENT_FUNDS')
  })

  it('maps RPC 429 to RATE_LIMITED and fetch failures to NETWORK', () => {
    expect(fromProgramError(new Error('429 Too Many Requests')).code).toBe('RATE_LIMITED')
    expect(fromProgramError(new TypeError('fetch failed')).code).toBe('NETWORK')
  })

  it('passes a HoragonError through unchanged', () => {
    const original = new HoragonError('NOT_FOUND', 'x')
    expect(fromProgramError(original)).toBe(original)
  })
})

describe('fromProgramError never puts raw error JSON in what a user reads', () => {
  const shapes: [string, unknown][] = [
    ['a builtin instruction error name', { InstructionError: [1, 'InvalidAccountData'] }],
    [
      'the same, as the status the API reads',
      { err: { InstructionError: [1, 'InvalidAccountData'] }, logs: [] },
    ],
    ['a Token program custom error', { InstructionError: [1, { Custom: 3 }] }],
    [
      'a Token program error with its logs',
      {
        err: { InstructionError: [2, { Custom: 1 }] },
        logs: [
          'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]',
          'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1',
        ],
      },
    ],
    ['an error whose message is JSON', new Error('{"InstructionError":[1,"InvalidAccountData"]}')],
  ]
  it.each(shapes)('%s', (_name, raw) => {
    const e = fromProgramError(raw)
    for (const text of [e.message, e.hint]) {
      expect(text).not.toMatch(/[{}[\]]|InstructionError/)
    }
    expect(e.message).toMatch(/^[A-Z][^\n]*\.?$/)
  })

  it('says what failed in words for a builtin error name', () => {
    const e = fromProgramError({ InstructionError: [1, 'InvalidAccountData'] })
    expect(e.code).toBe('PROGRAM_ERROR')
    expect(e.message).toBe('The network rejected step 2 of the transaction: invalid account data.')
  })
})
