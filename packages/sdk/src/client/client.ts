// `HoragonClient`: the API v1 over fetch (spec 19.2 modules game, market, quote, trade,
// position). Every response is validated with the same zod schema the API serves, and every
// problem+json answer becomes a HoragonError with the API's code, hint and Retry-After. GETs
// retry transient failures; POSTs never retry, since a build or a submit is not idempotent
// from the caller's point of view.
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
      this.get(`/markets/${pubkey}`, {}, MarketStateSchema),
  }

  quote(req: QuoteRequest): Promise<Quote> {
    return this.get('/quote', req, QuoteSchema)
  }

  readonly trade = {
    /** Unsigned v0 transaction; sign as the user, then `submit` (sponsored) or send it yourself. */
    build: (req: TradeBuildRequest): Promise<BuiltTx> =>
      this.post('/tx/trade', req, BuiltTxWireSchema),
    /** A user-signed sponsored transaction, base64. Returns at once; poll `status`. */
    submit: async (tx: string): Promise<string> =>
      (await this.post('/tx/submit', { tx }, SubmitResponseSchema)).signature,
    status: (signature: string): Promise<TxStatus> =>
      this.get(`/tx/${signature}`, {}, TxStatusSchema),
    /** Polls until confirmed, finalized or failed. A failure resolves; it does not throw. */
    waitFor: async (
      signature: string,
      opts: { timeoutMs?: number; pollMs?: number } = {},
    ): Promise<TxStatus> => {
      const deadline = Date.now() + (opts.timeoutMs ?? 60_000)
      for (;;) {
        const s = await this.trade.status(signature)
        if (s.status === 'confirmed' || s.status === 'finalized' || s.status === 'failed') return s
        if (Date.now() >= deadline) {
          throw new HoragonError('NETWORK', `${signature} not confirmed in time`, {
            hint: 'The transaction may still land; check its status again before resending.',
          })
        }
        await sleep(opts.pollMs ?? 1_000)
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
    return this.get(`/positions/${wallet}`, {}, PositionsResponseSchema)
  }

  faucet(wallet: string): Promise<FaucetResponse> {
    return this.post('/faucet', { wallet }, FaucetResponseSchema)
  }

  /** The evidence JSON exactly as published (the hashed bytes) and its sha256 header. */
  async evidence(
    gameId: string,
    kind: MarketKind = 'winner',
  ): Promise<{ json: string; sha256: string | null }> {
    const res = await this.request('GET', `/evidence/${encodeURIComponent(gameId)}/${kind}`)
    return { json: await res.text(), sha256: res.headers.get('x-evidence-sha256') }
  }

  async health(): Promise<Health> {
    const res = await this.send('GET', '/health', undefined, true)
    return HealthSchema.parse(await res.json())
  }

  private async get<S extends z.ZodType>(
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    schema: S,
    key?: string,
  ): Promise<z.infer<S>> {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v))
    const res = await this.request('GET', qs.size > 0 ? `${path}?${qs}` : path)
    const body: unknown = await res.json()
    return parse(schema, key ? (body as Record<string, unknown>)[key] : body, path)
  }

  private async post<S extends z.ZodType>(
    path: string,
    body: unknown,
    schema: S,
  ): Promise<z.infer<S>> {
    const res = await this.request('POST', path, body)
    return parse(schema, await res.json(), path)
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
    const attempts = method === 'GET' ? this.retries + 1 : 1
    let last: unknown
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(this.retryDelayMs * 2 ** (i - 1))
      try {
        return await this.send(method, path, body, false)
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
    acceptAnyStatus: boolean,
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
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (cause) {
      throw new HoragonError('NETWORK', `${method} ${path}: no response`, { cause })
    }
    if (res.ok || acceptAnyStatus) return res
    throw await problemError(res, `${method} ${path}`)
  }
}

async function problemError(res: Response, what: string): Promise<HoragonError> {
  const raw: unknown = await res.json().catch(() => null)
  const p = ProblemSchema.safeParse(raw)
  const retry = Number(res.headers.get('retry-after'))
  const retryAfterSecs = Number.isFinite(retry) && retry > 0 ? retry : undefined
  if (p.success && isCode(p.data.code)) {
    return new HoragonError(p.data.code, p.data.detail, {
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
    `${what} answered ${res.status}`,
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
