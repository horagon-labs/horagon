import { HoragonError, type HoragonErrorCode, isHoragonError } from '../errors'
import type { PmAmmInstructionName } from './instructions'

/** pm-AMM error names for the codes a market trader can hit (IDL `errors`, 6000+). */
export const PM_AMM_ERROR_NAMES: Readonly<Record<number, string>> = {
  6000: 'MarketAlreadyResolved',
  6001: 'MarketNotResolved',
  6002: 'MarketExpired',
  6003: 'MarketNotExpired',
  6004: 'InsufficientLiquidity',
  6005: 'InsufficientOutput',
  6006: 'InsufficientBalance',
  6007: 'SlippageExceeded',
  6008: 'Unauthorized',
  6009: 'InvalidPrice',
  6010: 'MathOverflow',
  6011: 'NoResidualsToClaim',
  6012: 'InvalidDuration',
  6013: 'InvalidBudget',
  6014: 'InvalidWinningMint',
  6015: 'InsufficientVault',
  6016: 'InvalidName',
  6035: 'InvalidMarketDuration',
}

/** Anchor's AccountNotInitialized: in a swap, a missing YES or NO token account. */
export const ANCHOR_ACCOUNT_NOT_INITIALIZED = 3012

const PROGRAM_CODE_MAP: Readonly<Record<number, [HoragonErrorCode, string]>> = {
  6000: ['MARKET_CLOSED', 'Market is already resolved'],
  6002: ['MARKET_CLOSED', 'Market has expired'],
  6004: ['MARKET_HALTED', 'Market has no liquidity (halted)'],
  6005: ['INVALID_INPUT', 'Trade is too small: the output rounds to zero'],
  6006: ['INSUFFICIENT_FUNDS', 'Not enough tokens for this trade'],
  6007: ['SLIPPAGE_EXCEEDED', 'Price moved beyond the slippage limit'],
  [ANCHOR_ACCOUNT_NOT_INITIALIZED]: [
    'MISSING_TOKEN_ACCOUNT',
    'A required token account does not exist',
  ],
}

function errorText(err: unknown): string {
  const parts: string[] = []
  if (err instanceof Error) parts.push(err.message)
  else if (typeof err === 'string') parts.push(err)
  else {
    // A confirmTransaction `value.err` such as {InstructionError: [2, {Custom: 6007}]}.
    try {
      parts.push(JSON.stringify(err) ?? String(err))
    } catch {
      parts.push(String(err))
    }
  }
  if (typeof err === 'object' && err !== null) {
    const logs =
      (err as { logs?: unknown; transactionLogs?: unknown }).logs ??
      (err as { transactionLogs?: unknown }).transactionLogs
    if (Array.isArray(logs)) parts.push(...logs.map(String))
  }
  return parts.join('\n')
}

/** The custom program error code in an error message or its logs, if any. */
export function extractProgramErrorCode(text: string): number | undefined {
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(text)
  if (hex?.[1]) return Number.parseInt(hex[1], 16)
  const json = /"Custom":\s*(\d+)/.exec(text)
  if (json?.[1]) return Number.parseInt(json[1], 10)
  const anchor = /Error Number: (\d+)/.exec(text)
  if (anchor?.[1]) return Number.parseInt(anchor[1], 10)
  const rust = /\bCustom\((\d+)\)/.exec(text)
  if (rust?.[1]) return Number.parseInt(rust[1], 10)
  return undefined
}

/** Which pm-AMM instruction failed, when the caller knows: some codes mean different things. */
export interface ProgramErrorContext {
  instruction?: PmAmmInstructionName
}

/** The builtin error name of an `{InstructionError: [index, "Name"]}` status, if that is the shape. */
function builtinInstructionError(err: unknown): { index: number; name: string } | undefined {
  const status = (err as { err?: unknown } | null)?.err ?? err
  const ie = (status as { InstructionError?: unknown } | null)?.InstructionError
  if (!Array.isArray(ie) || typeof ie[0] !== 'number' || typeof ie[1] !== 'string') return undefined
  return { index: ie[0], name: ie[1] }
}

const FAILED_HINT =
  'Refresh the page and try again. If it fails again, open the transaction on the explorer.'

/** Map anything thrown while sending a pm-AMM transaction to a HoragonError. */
export function fromProgramError(err: unknown, context: ProgramErrorContext = {}): HoragonError {
  if (isHoragonError(err)) return err
  const text = errorText(err)
  const code = extractProgramErrorCode(text)
  if (code === ANCHOR_ACCOUNT_NOT_INITIALIZED && context.instruction === 'claimLpResiduals') {
    // withdraw_liquidity(all shares) closes the LpPosition, so there is nothing left to claim.
    return new HoragonError('NOT_FOUND', 'No LP position: a full withdrawal closed it', {
      cause: err,
      programCode: code,
      hint: 'Nothing to do: the residuals were paid out when the liquidity was withdrawn.',
    })
  }
  if (code === 6004 && context.instruction !== undefined && context.instruction !== 'swap') {
    // Only a swap on a drained pool means the market is halted; a withdrawal or deposit that
    // hits InsufficientLiquidity asked for more than the pool or the LP position holds.
    return new HoragonError('PROGRAM_ERROR', 'Not enough liquidity for this instruction', {
      cause: err,
      programCode: code,
    })
  }
  // A program code wins over a stray "429" in the logs.
  if (code === undefined && /\b429\b|too many requests/i.test(text)) {
    return new HoragonError('RATE_LIMITED', 'RPC rate limit hit', { cause: err })
  }
  const mapped = code === undefined ? undefined : PROGRAM_CODE_MAP[code]
  if (code !== undefined && mapped) {
    return new HoragonError(mapped[0], mapped[1], { cause: err, programCode: code })
  }
  if (/insufficient funds|insufficient lamports|no record of a prior credit/i.test(text)) {
    return new HoragonError('INSUFFICIENT_FUNDS', 'Not enough SOL or tokens', {
      cause: err,
      ...(code === undefined ? {} : { programCode: code }),
    })
  }
  if (code !== undefined) {
    const name = PM_AMM_ERROR_NAMES[code] ?? 'unknown program error'
    return new HoragonError('PROGRAM_ERROR', `Program error ${code} (${name})`, {
      cause: err,
      programCode: code,
    })
  }
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(text)) {
    return new HoragonError('NETWORK', 'Network error while talking to the RPC', { cause: err })
  }
  const builtin = builtinInstructionError(err)
  if (builtin) {
    const words = builtin.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
    return new HoragonError(
      'PROGRAM_ERROR',
      `The network rejected step ${builtin.index + 1} of the transaction: ${words}.`,
      { cause: err, hint: FAILED_HINT },
    )
  }
  // Raw error JSON and program logs stay in `cause` (and the server log); a user reads a sentence.
  const first = text.split('\n')[0] ?? ''
  const plain = first !== '' && !/[{}[\]]|InstructionError/.test(first)
  return new HoragonError('PROGRAM_ERROR', plain ? first : 'The transaction failed on chain.', {
    cause: err,
    hint: FAILED_HINT,
  })
}
