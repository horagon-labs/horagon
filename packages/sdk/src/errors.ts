/** Error codes shared by every Horagon surface (SDK, API, CLI, MCP). */
export const HORAGON_ERROR_CODES = [
  'MARKET_CLOSED',
  'MARKET_HALTED',
  'SLIPPAGE_EXCEEDED',
  'MISSING_TOKEN_ACCOUNT',
  'INSUFFICIENT_FUNDS',
  'RATE_LIMITED',
  'SPONSOR_REJECTED',
  'MAINNET_DISABLED',
  'NOT_FOUND',
  'NETWORK',
  'PROGRAM_ERROR',
  'INVALID_INPUT',
] as const

export type HoragonErrorCode = (typeof HORAGON_ERROR_CODES)[number]

/** Default `hint` per code: always something the user can do right now. */
export const DEFAULT_HINTS: Readonly<Record<HoragonErrorCode, string>> = {
  MARKET_CLOSED: 'This market no longer accepts trades. Pick an open market with `horagon games`.',
  MARKET_HALTED: 'Trading on this market is halted. Wait for the result, then claim.',
  SLIPPAGE_EXCEEDED: 'The price moved. Request a new quote and retry.',
  MISSING_TOKEN_ACCOUNT:
    'Rebuild the transaction with `hg.trade.build`; it creates the YES and NO token accounts first.',
  INSUFFICIENT_FUNDS: 'Run `horagon wallet fund` to get devnet mUSDC and SOL.',
  RATE_LIMITED: 'Wait a few seconds and retry.',
  SPONSOR_REJECTED: 'Build the transaction with `hg.trade.build` so it passes the sponsor rules.',
  MAINNET_DISABLED: "Horagon runs on devnet only. Use cluster 'devnet' or 'localnet'.",
  NOT_FOUND: 'Check the id. List valid ids with `horagon games`.',
  NETWORK: 'Check your connection and RPC URL, then retry.',
  PROGRAM_ERROR: 'Inspect the transaction with `horagon debug tx <signature>`.',
  INVALID_INPUT: 'Fix the argument named in the message and retry.',
}

export interface HoragonErrorOptions {
  hint?: string
  cause?: unknown
  /** Raw on-chain error code, when the error came from a program. */
  programCode?: number
}

export class HoragonError extends Error {
  readonly code: HoragonErrorCode
  readonly hint: string
  readonly programCode: number | undefined

  constructor(code: HoragonErrorCode, message: string, options: HoragonErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HoragonError'
    this.code = code
    this.hint = options.hint ?? DEFAULT_HINTS[code]
    this.programCode = options.programCode
  }

  toJSON(): { code: HoragonErrorCode; message: string; hint: string; programCode?: number } {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      ...(this.programCode === undefined ? {} : { programCode: this.programCode }),
    }
  }
}

export function isHoragonError(value: unknown): value is HoragonError {
  return value instanceof HoragonError
}
