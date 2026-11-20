import type { PublicKey } from '@solana/web3.js'
import { PM_AMM_PROGRAM_ID } from '../pm-amm/constants'
import { HORAGON_PROGRAM_ID } from './constants'

/** `HoragonError` of programs/horagon/src/errors.rs, code 6000 upwards, in order. */
export const HORAGON_PROGRAM_ERRORS = [
  'Unauthorized',
  'CreationPaused',
  'PriceOutOfRange',
  'EndTooSoon',
  'InsufficientTreasury',
  'BadStatus',
  'TooEarly',
  'WindowOpen',
  'WindowClosed',
  'InvalidArgument',
  'BadLpPosition',
] as const
export type HoragonProgramErrorName = (typeof HORAGON_PROGRAM_ERRORS)[number]

export function horagonErrorName(code: number): HoragonProgramErrorName | undefined {
  return HORAGON_PROGRAM_ERRORS[code - 6000]
}

const FAILED = /^Program (\w+) failed: custom program error: 0x([0-9a-f]+)$/i

/**
 * Which program raised the custom error in a failed transaction, read from the logs. pm-AMM
 * and `horagon` both number from 6000, so the bare code is ambiguous: a CPI failure is logged
 * by the inner program first, and that first line names the program that raised it.
 */
export function failedProgramError(
  logs: readonly string[],
  programId: PublicKey = HORAGON_PROGRAM_ID,
  pmAmmProgramId: PublicKey = PM_AMM_PROGRAM_ID,
): { program: 'horagon' | 'pm-amm' | 'other'; code: number; name?: string } | undefined {
  for (const line of logs) {
    const m = FAILED.exec(line)
    if (!m?.[1] || !m[2]) continue
    const code = Number.parseInt(m[2], 16)
    if (m[1] === programId.toBase58()) {
      const name = horagonErrorName(code)
      return name ? { program: 'horagon', code, name } : { program: 'horagon', code }
    }
    return { program: m[1] === pmAmmProgramId.toBase58() ? 'pm-amm' : 'other', code }
  }
  return undefined
}
