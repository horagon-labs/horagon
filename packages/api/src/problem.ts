// RFC 9457 problem details with Horagon's error code (spec 19.3). Every error leaves the API
// through `problemResponse`; nothing else ever reaches the client, so an exception's text
// (which may hold an RPC URL or a stack) is logged, not echoed.
import { DEFAULT_HINTS, type HoragonErrorCode, isHoragonError, redactUrls } from '@horagon/sdk'

export const STATUS_BY_CODE: Readonly<Record<HoragonErrorCode, number>> = {
  INVALID_INPUT: 400,
  SPONSOR_REJECTED: 400,
  MAINNET_DISABLED: 400,
  NOT_FOUND: 404,
  MARKET_CLOSED: 409,
  MARKET_HALTED: 409,
  SLIPPAGE_EXCEEDED: 409,
  MISSING_TOKEN_ACCOUNT: 409,
  INSUFFICIENT_FUNDS: 409,
  RATE_LIMITED: 429,
  PROGRAM_ERROR: 422,
  NETWORK: 502,
}

/** The hint of an unexpected server fault: nothing the client can fix on its side. */
export const SERVER_FAULT_HINT =
  'Something failed on the server. Retry in a few seconds; if it persists, report the request id.'

/** An error meant for the client: its message and fields are safe to show. */
export class ApiError extends Error {
  constructor(
    readonly code: HoragonErrorCode,
    message: string,
    readonly extra: {
      status?: number
      hint?: string
      reason?: string
      programCode?: number
      retryAfterSecs?: number
      /** A transaction signature the client should look up (RFC 9457 extension member). */
      signature?: string
      /** What went wrong underneath, for the logs only: never serialized into the response. */
      cause?: unknown
    } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause })
    this.name = 'ApiError'
  }
}

export interface ProblemBody {
  type: string
  title: string
  status: number
  detail: string
  code: HoragonErrorCode
  hint?: string
  programCode?: number
  reason?: string
  signature?: string
  requestId?: string
}

export function problemBody(err: unknown, requestId?: string): ProblemBody {
  if (err instanceof ApiError) {
    const status = err.extra.status ?? STATUS_BY_CODE[err.code]
    return {
      type: `https://horagon.com/docs/errors#${err.code.toLowerCase()}`,
      title: err.code,
      status,
      detail: err.message,
      code: err.code,
      hint: err.extra.hint ?? DEFAULT_HINTS[err.code],
      ...(err.extra.programCode === undefined ? {} : { programCode: err.extra.programCode }),
      ...(err.extra.reason === undefined ? {} : { reason: err.extra.reason }),
      ...(err.extra.signature === undefined ? {} : { signature: err.extra.signature }),
      ...(requestId ? { requestId } : {}),
    }
  }
  // HoragonError messages are written for users (SDK input checks, program error mapping), but
  // one built from an RPC failure can still quote a URL: redact it.
  if (isHoragonError(err)) {
    return {
      type: `https://horagon.com/docs/errors#${err.code.toLowerCase()}`,
      title: err.code,
      status: STATUS_BY_CODE[err.code],
      detail: redactUrls(err.message),
      code: err.code,
      hint: err.hint,
      ...(err.programCode === undefined ? {} : { programCode: err.programCode }),
      ...(requestId ? { requestId } : {}),
    }
  }
  return {
    type: 'https://horagon.com/docs/errors#network',
    title: 'NETWORK',
    status: 500,
    detail: 'Internal error. Retry; if it persists, report the request id.',
    code: 'NETWORK',
    hint: SERVER_FAULT_HINT,
    ...(requestId ? { requestId } : {}),
  }
}

function retryAfterOf(err: unknown): number | undefined {
  if (err instanceof ApiError) return err.extra.retryAfterSecs
  if (isHoragonError(err)) return err.retryAfterSecs
  return undefined
}

export function problemResponse(err: unknown, requestId?: string): Response {
  const body = problemBody(err, requestId)
  const headers = new Headers({ 'content-type': 'application/problem+json' })
  if (requestId) headers.set('x-request-id', requestId)
  const retryAfter = retryAfterOf(err)
  if (retryAfter !== undefined && Number.isFinite(retryAfter)) {
    headers.set('retry-after', String(Math.max(1, Math.ceil(retryAfter))))
  }
  return new Response(JSON.stringify(body), { status: body.status, headers })
}
