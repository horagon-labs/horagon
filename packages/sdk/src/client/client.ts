// `HoragonClient`: the API v1 over fetch (spec 19.2 modules game, market, quote, trade,
// position). Every response is validated with the same zod schema the API serves, and every
// problem+json answer becomes a HoragonError with the API's code, hint and Retry-After. GETs
// retry transient failures; POSTs never retry, since a build or a submit is not idempotent
// from the caller's point of view. Every failure is a HoragonError: a body that cannot be read
// (bad JSON, an HTML error page, an aborted read) is a NETWORK error too, and GETs retry it.
import type { z } from 'zod'
import { HORAGON_ERROR_CODES, HoragonError, type HoragonErrorCode, isHoragonError } from '../errors'
import {
  BuiltTxWireSchema,
  type ClaimBuildResponse,
  ClaimBuildResponseSchema,
  type FaucetResponse,
  FaucetResponseSchema,
  type Game,
  type GameDetail,
  GameDetailSchema,
  type GameHistory,
  GameSchema,
  type GameStatus,
  type Health,
  HealthSchema,
  HistorySchema,
  type MarketKind,
  type MarketState,
  MarketStateSchema,
  type Position,
  type PositionsResponse,
  PositionsResponseSchema,
  ProblemSchema,
  type Quote,
  type QuoteRequest,
  QuoteSchema,
  SubmitResponseSchema,
  type TradeBuildRequest,
  type TxStatus,
  TxStatusSchema,
} from '../schemas'

export type BuiltTx = z.infer<typeof BuiltTxWireSchema>

export interface HoragonClientOptions {
  /** e.g. "https://horagon.vercel.app/api/v1". */
  baseUrl: string
  fetch?: typeof fetch
  /** Per request (default 10 s). */
  timeoutMs?: number
  /** Extra attempts for a GET that hit the network or a 5xx (default 2). */
  retries?: number
  /** Between GET retries (default 300 ms, doubled each time). */
  retryDelayMs?: number
}

interface RequestOpts {
  /** Hand back a non-2xx response instead of throwing (health). */
  anyStatus?: boolean
  as?: 'json' | 'text'
  /** Upper bound for this call, below the client's own timeout. */
  timeoutMs?: number
  retries?: number
}

const GamesSchema = GameSchema.array()
const isCode = (c: unknown): c is HoragonErrorCode =>
  typeof c === 'string' && (HORAGON_ERROR_CODES as readonly string[]).includes(c)

export class HoragonClient {
  private readonly base: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly retryDelayMs: number

  constructor(opts: HoragonClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis)
    this.timeoutMs = opts.timeoutMs ?? 10_000
    this.retries = opts.retries ?? 2
    this.retryDelayMs = opts.retryDelayMs ?? 300
  }

  readonly games = {
    /** Games of one ET game date (`date`), or of today and tomorrow ET. */
    list: (q: { date?: string; status?: GameStatus } = {}): Promise<Game[]> =>
      this.get('/games', q, GamesSchema, 'games'),
    get: (id: string): Promise<GameDetail> =>
      this.get(`/games/${encodeURIComponent(id)}`, {}, GameDetailSchema),
    history: (id: string): Promise<GameHistory> =>
      this.get(`/games/${encodeURIComponent(id)}/history`, {}, HistorySchema),
  }

  readonly markets = {
    get: (pubkey: string): Promise<MarketState> =>
      this.get(`/markets/${encodeURIComponent(pubkey)}`, {}, MarketStateSchema),
  }

  quote(req: QuoteRequest): Promise<Quote> {
    return this.get('/quote', req, QuoteSchema)
  }

  readonly trade = {
    /** Unsigned v0 transaction; sign as the user, then `submit` (sponsored) or send it yourself. */
    build: (req: TradeBuildRequest): Promise<BuiltTx> =>
      this.post('/tx/trade', req, BuiltTxWireSchema),
    /** A user-signed sponsored transaction, base64. Returns at once; poll `status`. */
    submit: async (tx: string): Promise<string> => {
      try {
        return (await this.post('/tx/submit', { tx }, SubmitResponseSchema)).signature
      } catch (err) {
        if (isHoragonError(err) && err.code === 'NETWORK') {
          // The sponsor may have sent it before the answer was lost. Rebuilding would trade twice.
          throw new HoragonError('NETWORK', err.message, {
            hint: 'The transaction may already have been sent. Do not rebuild or sign a new one: check trade.status and the wallet positions first, or resend the same signed transaction.',
            cause: err,
          })
        }
        throw err
      }
    },
    status: (signature: string): Promise<TxStatus> =>
      this.get(`/tx/${encodeURIComponent(signature)}`, {}, TxStatusSchema),
    /** Polls until confirmed, finalized or failed. A failure resolves; it does not throw. */
    waitFor: async (
      signature: string,
      opts: { timeoutMs?: number; pollMs?: number } = {},
    ): Promise<TxStatus> => {
      const deadline = Date.now() + (opts.timeoutMs ?? 60_000)
      for (;;) {
        const left = deadline - Date.now()
        if (left > 0) {
          try {
            // One attempt, capped by the time left; a transient failure just means poll again.
            const s = await this.get(
              `/tx/${encodeURIComponent(signature)}`,
              {},
              TxStatusSchema,
              undefined,
              { timeoutMs: left, retries: 0 },
            )
            if (s.status === 'confirmed' || s.status === 'finalized' || s.status === 'failed') {
              return s
            }
          } catch (err) {
            if (!(isHoragonError(err) && err.code === 'NETWORK')) throw err
          }
        }
        if (Date.now() >= deadline) {
          throw new HoragonError('NETWORK', `${signature} not confirmed in time`, {
            hint: 'The transaction may still land; check its status again before resending.',
          })
        }
        await sleep(Math.min(opts.pollMs ?? 1_000, Math.max(deadline - Date.now(), 0)))
      }
    },
  }

  readonly claims = {
    build: (req: { wallet: string; sponsored?: boolean }): Promise<ClaimBuildResponse> =>
      this.post('/tx/claim', req, ClaimBuildResponseSchema),
  }

  async positions(wallet: string): Promise<Position[]> {
    return (await this.portfolio(wallet)).positions
  }

  /** Positions plus the wallet's mUSDC balance, in one request. */
  portfolio(wallet: string): Promise<PositionsResponse> {
    return this.get(`/positions/${encodeURIComponent(wallet)}`, {}, PositionsResponseSchema)
  }

  faucet(wallet: string): Promise<FaucetResponse> {
    return this.post('/faucet', { wallet }, FaucetResponseSchema)
  }

  /** The evidence JSON exactly as published (the hashed bytes) and its sha256 header. */
  async evidence(
    gameId: string,
    kind: MarketKind = 'winner',
  ): Promise<{ json: string; sha256: string | null }> {
    const { res, data } = await this.request(
      'GET',
      `/evidence/${encodeURIComponent(gameId)}/${encodeURIComponent(kind)}`,
      undefined,
      { as: 'text' },
    )
    return { json: String(data), sha256: res.headers.get('x-evidence-sha256') }
  }

  async health(): Promise<Health> {
    const { data } = await this.request('GET', '/health', undefined, { anyStatus: true })
    return parse(HealthSchema, data, '/health')
  }

  private async get<S extends z.ZodType>(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    schema: S,
    key?: string,
    override: RequestOpts = {},
  ): Promise<z.infer<S>> {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v))
    // `URLSearchParams#size` is missing before Safari 17, so build the string instead.
    const q = qs.toString()
    const { data: body } = await this.request(
      'GET',
      q === '' ? path : `${path}?${q}`,
      undefined,
      override,
    )
    return parse(schema, key ? (body as Record<string, unknown>)[key] : body, path)
  }

  private async post<S extends z.ZodType>(
    path: string,
    body: unknown,
    schema: S,
  ): Promise<z.infer<S>> {
    const { data } = await this.request('POST', path, body)
    return parse(schema, data, path)
  }

  /** One exchange: send, then read the whole body. Both steps sit inside the retry loop. */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    opts: RequestOpts = {},
  ): Promise<{ res: Response; data: unknown }> {
    const attempts = method === 'GET' ? (opts.retries ?? this.retries) + 1 : 1
    let last: unknown
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(this.retryDelayMs * 2 ** (i - 1))
      try {
        const res = await this.send(method, path, body, opts)
        return { res, data: await readBody(res, method, path, opts.as ?? 'json') }
      } catch (err) {
        last = err
        const transient = isHoragonError(err) && err.code === 'NETWORK'
        if (!transient) throw err
      }
    }
    throw last
  }

  private async send(
    method: string,
    path: string,
    body: unknown,
    opts: RequestOpts,
  ): Promise<Response> {
    let res: Response
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers:
          body === undefined
            ? { accept: 'application/json' }
            : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, opts.timeoutMs ?? this.timeoutMs)),
      })
    } catch (cause) {
      throw new HoragonError('NETWORK', `${method} ${path}: no response`, { cause })
    }
    if (res.ok || opts.anyStatus) return res
    throw await problemError(res, `${method} ${path}`)
  }
}

async function readBody(
  res: Response,
  method: string,
  path: string,
  as: 'json' | 'text',
): Promise<unknown> {
  try {
    return as === 'text' ? await res.text() : await res.json()
  } catch (cause) {
    throw new HoragonError('NETWORK', `${method} ${path}: unreadable response (${res.status})`, {
      cause,
    })
  }
}

/** Seconds from a Retry-After header, as delta-seconds or an HTTP date (at least 1). */
function retryAfter(header: string | null): number | undefined {
  if (header === null || header.trim() === '') return undefined
  const n = Number(header)
  if (Number.isFinite(n)) return n > 0 ? n : undefined
  const at = Date.parse(header)
  return Number.isNaN(at) ? undefined : Math.max(1, Math.ceil((at - Date.now()) / 1000))
}

async function problemError(res: Response, what: string): Promise<HoragonError> {
  const raw: unknown = await res.json().catch(() => null)
  const p = ProblemSchema.safeParse(raw)
  const retryAfterSecs = retryAfter(res.headers.get('retry-after'))
  const requestId =
    (p.success ? p.data.requestId : undefined) ?? res.headers.get('x-request-id') ?? undefined
  const rid = requestId === undefined ? '' : ` (request id ${requestId})`
  if (p.success && isCode(p.data.code)) {
    const reason = p.data.reason === undefined ? '' : ` [${p.data.reason}]`
    return new HoragonError(p.data.code, `${p.data.detail}${reason}${rid}`, {
      ...(p.data.hint === undefined ? {} : { hint: p.data.hint }),
      ...(p.data.programCode === undefined ? {} : { programCode: p.data.programCode }),
      ...(retryAfterSecs === undefined ? {} : { retryAfterSecs }),
    })
  }
  const code: HoragonErrorCode =
    res.status === 404
      ? 'NOT_FOUND'
      : res.status === 429
        ? 'RATE_LIMITED'
        : res.status >= 500
          ? 'NETWORK'
          : 'INVALID_INPUT'
  return new HoragonError(
    code,
    `${what} answered ${res.status}${rid}`,
    retryAfterSecs === undefined ? {} : { retryAfterSecs },
  )
}

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(value)
  if (!r.success) {
    throw new HoragonError(
      'NETWORK',
      `${what}: unexpected response shape (${r.error.issues[0]?.message ?? 'invalid'})`,
      {
        hint: 'The API and this SDK version disagree; upgrade @horagon/sdk.',
      },
    )
  }
  return r.data
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
