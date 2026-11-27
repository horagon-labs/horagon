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

/**
 * Default `hint` per code: always something the user can do right now, with what exists today:
 * the site, API v1 routes and SDK methods. Horagon has no CLI for players.
 */
export const DEFAULT_HINTS: Readonly<Record<HoragonErrorCode, string>> = {
  MARKET_CLOSED:
    'This market no longer accepts trades. Pick an open game on the board, or from GET /api/v1/games.',
  MARKET_HALTED: 'Trading on this market is halted. Wait for the result, then claim.',
  SLIPPAGE_EXCEEDED: 'The price moved. Request a new quote and retry.',
  MISSING_TOKEN_ACCOUNT:
    'Rebuild the transaction with POST /api/v1/tx/trade (trade.build in the SDK); it creates the YES and NO token accounts first.',
  INSUFFICIENT_FUNDS:
    'Get devnet mUSDC from the faucet, then retry; a sponsored trade needs no SOL.',
  RATE_LIMITED: 'Wait a few seconds and retry.',
  SPONSOR_REJECTED:
    'Build the transaction with POST /api/v1/tx/trade (trade.build in the SDK) so it passes the sponsor rules.',
  MAINNET_DISABLED: "Horagon runs on devnet only. Use cluster 'devnet' or 'localnet'.",
  NOT_FOUND: 'Check the id or the path. Game ids are listed by GET /api/v1/games.',
  NETWORK: 'Check your connection and RPC URL, then retry.',
  PROGRAM_ERROR:
    'Look the transaction up with GET /api/v1/tx/<signature>, or on Solana Explorer (devnet).',
  INVALID_INPUT: 'Fix the argument named in the message and retry.',
}

export interface HoragonErrorOptions {
  hint?: string
  cause?: unknown
  /** Raw on-chain error code, when the error came from a program. */
  programCode?: number
  /** RATE_LIMITED: seconds until a retry can succeed (the API's Retry-After). */
  retryAfterSecs?: number
}

export class HoragonError extends Error {
  readonly code: HoragonErrorCode
  readonly hint: string
  readonly programCode: number | undefined
  readonly retryAfterSecs: number | undefined

  constructor(code: HoragonErrorCode, message: string, options: HoragonErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HoragonError'
    this.code = code
    this.hint = options.hint ?? DEFAULT_HINTS[code]
    this.programCode = options.programCode
    this.retryAfterSecs = options.retryAfterSecs
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

/**
 * True for a HoragonError from any copy of the SDK. `instanceof` alone fails across the ESM and
 * CJS builds (two class objects), so this also accepts any error named `HoragonError` whose
 * `code` is in the table.
 */
export function isHoragonError(value: unknown): value is HoragonError {
  if (value instanceof HoragonError) return true
  if (!(value instanceof Error) || value.name !== 'HoragonError') return false
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && (HORAGON_ERROR_CODES as readonly string[]).includes(code)
}

/** Cuts URL paths and query strings (where RPC providers put API keys) and `api-key` values. */
export function redactUrls(text: string): string {
  return text
    .replace(/\b(https?|wss?):\/\/(?:[^\s/?#]*@)?([^\s/?#]+)[^\s"']*/gi, '$1://$2/…')
    .replace(/(api[-_]?key|token)=[^&\s"']+/gi, '$1=…')
}

/**
 * What a log line may carry about an error: its name, code and a redacted, shortened message.
 * Never the stack, the cause chain or a keyed RPC URL.
 */
export function errorSummary(err: unknown): { name: string; code?: string; message: string } {
  const name = err instanceof Error ? err.name : typeof err
  let message: string
  if (err instanceof Error) message = err.message
  else if (typeof err === 'string') message = err
  else {
    try {
      message = JSON.stringify(err) ?? String(err)
    } catch {
      message = String(err)
    }
  }
  const code = (err as { code?: unknown } | null)?.code
  return {
    name,
    ...(typeof code === 'string' ? { code } : {}),
    message: redactUrls(message).slice(0, 300),
  }
}
