// API v1 (spec 19.3), Tier 1 routes. Mounted by Next.js at /api/v1 and by `horagon dev`.
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import {
  getEvidence,
  getGame,
  getHeartbeat,
  latestPrices,
  listGames,
  listMarketTrades,
  listPricePoints,
  listSnapshots,
  readFlags,
  walletsWithBotMemo,
} from '@horagon/db'
import {
  BuiltTxWireSchema,
  ClaimBuildRequestSchema,
  ClaimBuildResponseSchema,
  effectiveTime,
  errorSummary,
  FaucetRequestSchema,
  FaucetResponseSchema,
  FlagsResponseSchema,
  formatAmount,
  GameDetailSchema,
  GameIdSchema,
  GameSchema,
  GamesQuerySchema,
  HealthSchema,
  HistorySchema,
  liveMarket,
  MARKET_KIND_CODE,
  MarketKindSchema,
  MarketStateSchema,
  MeResponseSchema,
  marketKindName,
  PositionsResponseSchema,
  PracticeResponseSchema,
  PubkeySchema,
  QuoteRequestSchema,
  QuoteSchema,
  SignatureSchema,
  SubmitRequestSchema,
  SubmitResponseSchema,
  TradeBuildRequestSchema,
  TxStatusSchema,
} from '@horagon/sdk'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { etag, RETAINED_304_HEADERS } from 'hono/etag'
import { HTTPException } from 'hono/http-exception'
import { requestId } from 'hono/request-id'
import { gameActivity } from './activity'
import { ChainReader } from './chain'
import type { ApiDeps } from './deps'
import { disputeWindowReader } from './dispute-window'
import { claimFaucet } from './faucet'
import { flagsOf, provideFlags, requireFlags } from './flags'
import { agentBeat, healthOpsReader } from './health-ops'
import { MeQuerySchema, meFor, positionsAndNights } from './me'
import { practiceFor } from './practice'
import { ApiError, problemResponse } from './problem'
import {
  buildClaims,
  buildTrade,
  type Ctx,
  horagonMarket,
  positionsFor,
  quote,
  toQuoteWire,
  txStatus,
  usdcBalanceOf,
} from './services'
import { MarketSet, submitSponsored } from './sponsor/submit'
import { etDayRange, etNextDay, etNight, toGame, toGameDetail, toHistory } from './views'

type Env = { Variables: { requestId: string } }

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})
const body = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } }, required: true },
})

/** Where an input lives, in the words of the API docs. */
const TARGET_LABEL: Readonly<Record<string, string>> = {
  json: 'body',
  query: 'query',
  param: 'params',
}

function zodDetail(error: z.ZodError, target: string): string {
  const label = TARGET_LABEL[target] ?? target
  return error.issues
    .slice(0, 3)
    .map((i) => `${[label, ...i.path].join('.')}: ${i.message}`)
    .join('; ')
}

/** Hono's own 4xx (bad JSON, wrong content type), told in words that echo nothing back. */
function httpProblem(err: HTTPException): ApiError {
  const message =
    err.status === 400
      ? 'The request body is not valid JSON'
      : err.status === 415
        ? 'Send the request body as application/json'
        : `The request was refused (HTTP ${err.status})`
  return new ApiError('INVALID_INPUT', message, { status: err.status })
}

/** Headers a browser on another origin may read: limits, request ids, caching, evidence. */
const EXPOSED_HEADERS = ['retry-after', 'x-request-id', 'etag', 'x-evidence-sha256']

/**
 * Client IP: the left-most `x-forwarded-for` entry, then `x-real-ip`. Only ever stored hashed.
 * This is safe only behind a proxy that overwrites the header (Vercel does); anywhere else a
 * client can choose its own IP bucket. A request without either header lands in one shared
 * bucket, 'unknown'.
 */
function clientIp(headers: Headers): string {
  const fwd = headers.get('x-forwarded-for')
  return fwd?.split(',')[0]?.trim() || headers.get('x-real-ip') || 'unknown'
}

export function createApp(deps: ApiDeps) {
  const ctx: Ctx = { deps, chain: new ChainReader(deps.connection) }
  const marketSet = new MarketSet(deps)
  // One reader per app: the on-chain challenge window, kept 600 s (dispute-window.ts).
  const disputeWindow = disputeWindowReader(deps)
  // The ops numbers of /health: chain and backlog reads kept 45 s (health-ops.ts).
  const healthOps = healthOpsReader(deps)
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return problemResponse(
          new ApiError('INVALID_INPUT', zodDetail(result.error, result.target)),
          c.get('requestId'),
        )
      }
    },
  }).basePath('/api/v1')

  app.use('*', requestId())
  // Read lazily: a route that never asks costs no query (packages/api/src/flags.ts).
  app.use(
    '*',
    provideFlags(() => readFlags(deps.db)),
  )
  app.use('*', async (c, next) => {
    const started = performance.now()
    await next()
    deps.log.info(
      {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      'request',
    )
  })
  // `/tx/*` first: a cors middleware answers a preflight itself, so the first match decides it.
  app.use(
    '/tx/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST'],
      allowHeaders: ['content-type'],
      exposeHeaders: EXPOSED_HEADERS,
    }),
  )
  app.use('*', cors({ origin: '*', allowMethods: ['GET'], exposeHeaders: EXPOSED_HEADERS }))
  app.use(
    '*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) =>
        problemResponse(
          new ApiError('INVALID_INPUT', 'Body larger than 64 KB', { status: 413 }),
          c.get('requestId'),
        ),
    }),
  )
  app.use(
    '/tx/submit',
    bodyLimit({
      maxSize: 4 * 1024,
      onError: (c) =>
        problemResponse(
          new ApiError('INVALID_INPUT', 'Body larger than 4 KB', { status: 413 }),
          c.get('requestId'),
        ),
    }),
  )
  // A 304 keeps only the retained headers: add the request id and the CORS headers to them.
  app.use(
    '/games/*',
    etag({
      weak: true,
      retainedHeaders: [
        ...RETAINED_304_HEADERS,
        'x-request-id',
        'access-control-allow-origin',
        'access-control-expose-headers',
      ],
    }),
  )
  // My Game-day (R7): 404 problem+json while FLAG_ME is off, before any input check.
  app.use('/me/*', requireFlags('FLAG_ME'))
  // Practice (R8): 404 problem+json while FLAG_PRACTICE is off.
  app.use('/practice', requireFlags('FLAG_PRACTICE'))
  app.onError((err, c) => {
    const rid = c.get('requestId')
    // Hono's 4xx are the client's mistake: answer them, nothing to log.
    if (err instanceof HTTPException && err.status < 500) {
      return problemResponse(httpProblem(err), rid)
    }
    if (err instanceof ApiError) {
      // An ApiError is meant for the client; only what went wrong underneath is worth a line.
      if (err.extra.cause !== undefined) {
        deps.log.warn(
          { error: errorSummary(err.extra.cause), code: err.code, requestId: rid },
          'request failed',
        )
      }
    } else {
      deps.log.error({ error: errorSummary(err), requestId: rid }, 'unhandled')
    }
    return problemResponse(err, rid)
  })
  app.notFound((c) =>
    problemResponse(new ApiError('NOT_FOUND', `No route ${c.req.path}`), c.get('requestId')),
  )

  const cacheShort = 's-maxage=1, stale-while-revalidate=5'

  app.openapi(
    createRoute({
      method: 'get',
      path: '/games',
      request: { query: GamesQuerySchema },
      responses: { 200: json(z.object({ games: z.array(GameSchema) }), 'Games') },
    }),
    async (c) => {
      const q = c.req.valid('query')
      const now = deps.now()
      const night = etNight(now)
      const range = q.date
        ? etDayRange(q.date)
        : { from: etDayRange(night).from, to: etDayRange(etNextDay(night)).to }
      // NBA only: a Practice replay is never one of the night's games (R8).
      const games = await listGames(deps.db, {
        ...range,
        ...(q.status ? { statuses: q.status } : {}),
        leagues: ['NBA'],
      })
      const prices = await latestPrices(
        deps.db,
        games.flatMap((g) => g.markets.map((m) => m.pubkey)),
      )
      c.header('cache-control', cacheShort)
      return c.json({ games: games.map((g) => toGame(g, prices)) }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/games/{id}',
      request: { params: z.object({ id: GameIdSchema }) },
      responses: { 200: json(GameDetailSchema, 'Game detail') },
    }),
    async (c) => {
      const g = await getGame(deps.db, c.req.valid('param').id)
      if (!g) throw new ApiError('NOT_FOUND', 'No such game')
      const keys = g.markets.map((m) => m.pubkey)
      // The window is read on chain only while a result is proposed (kept 600 s, null on failure).
      const proposed = g.markets.some((m) => m.status === 'proposed')
      const [prices, trades, windowSecs] = await Promise.all([
        latestPrices(deps.db, keys),
        listMarketTrades(deps.db, keys),
        proposed ? disputeWindow() : Promise.resolve(null),
      ])
      const memo = await walletsWithBotMemo(deps.db, [...new Set(trades.map((t) => t.wallet))])
      const activity = gameActivity(trades, memo)
      c.header('cache-control', cacheShort)
      return c.json(toGameDetail(g, prices, deps.publicUrl, activity, windowSecs), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/games/{id}/history',
      request: { params: z.object({ id: GameIdSchema }) },
      responses: { 200: json(HistorySchema, 'Snapshots and price points') },
    }),
    async (c) => {
      const id = c.req.valid('param').id
      const g = await getGame(deps.db, id)
      if (!g) throw new ApiError('NOT_FOUND', 'No such game')
      const [snaps, prices] = await Promise.all([
        listSnapshots(deps.db, id),
        listPricePoints(
          deps.db,
          g.markets.map((m) => m.pubkey),
        ),
      ])
      c.header('cache-control', 's-maxage=5, stale-while-revalidate=30')
      return c.json(toHistory(id, snaps, prices), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/markets/{pubkey}',
      request: { params: z.object({ pubkey: PubkeySchema }) },
      responses: { 200: json(MarketStateSchema, 'Market state at now') },
    }),
    async (c) => {
      const { row, account } = await horagonMarket(ctx, c.req.valid('param').pubkey)
      // The time this state is valid at: never before the pool's last accrual.
      const now = effectiveTime(deps.now(), account.lastAccrualTs)
      const live = liveMarket(account, now)
      const last = (await latestPrices(deps.db, [row.pubkey])).get(row.pubkey)
      return c.json(
        {
          pubkey: row.pubkey,
          gameId: row.gameId,
          kind: marketKindName(row.kind),
          status: row.status as z.infer<typeof MarketStateSchema>['status'],
          authority: account.authority.toBase58(),
          collateralMint: account.collateralMint.toBase58(),
          yesMint: account.yesMint.toBase58(),
          noMint: account.noMint.toBase58(),
          startTs: account.startTs,
          endTs: account.endTs,
          now,
          price: live.price ?? last?.price ?? row.initialPriceBps / 10_000,
          liquidityUsdc: formatAmount(BigInt(Math.floor(live.liquidity))),
          resolved: account.resolved,
          winningSide: account.resolved
            ? account.winningSide === 1
              ? ('yes' as const)
              : ('no' as const)
            : null,
          externalLp: row.externalLp,
        },
        200,
      )
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/quote',
      request: { query: QuoteRequestSchema },
      responses: { 200: json(QuoteSchema, 'Quote') },
    }),
    async (c) => {
      const { q, now } = await quote(ctx, c.req.valid('query'))
      return c.json(toQuoteWire(q, now), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/evidence/{gameId}/{kind}',
      request: { params: z.object({ gameId: GameIdSchema, kind: MarketKindSchema }) },
      responses: { 200: json(z.record(z.string(), z.unknown()), 'The JCS evidence JSON') },
    }),
    async (c) => {
      const { gameId, kind } = c.req.valid('param')
      const e = await getEvidence(deps.db, gameId, MARKET_KIND_CODE[kind])
      if (!e) throw new ApiError('NOT_FOUND', 'No evidence published for this market yet')
      // The stored string is the exact byte sequence that was hashed: send it untouched.
      return new Response(e.json, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-evidence-sha256': e.hash,
          'cache-control': 'public, max-age=60',
          'x-request-id': c.get('requestId'),
        },
      }) as never
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/tx/trade',
      request: body(TradeBuildRequestSchema),
      responses: { 200: json(BuiltTxWireSchema, 'Unsigned transaction and its quote') },
    }),
    async (c) => c.json(await buildTrade(ctx, c.req.valid('json')), 200),
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/tx/claim',
      request: body(ClaimBuildRequestSchema),
      responses: { 200: json(ClaimBuildResponseSchema, 'Unsigned claim transactions') },
    }),
    async (c) => c.json(await buildClaims(ctx, c.req.valid('json')), 200),
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/tx/submit',
      request: body(SubmitRequestSchema),
      responses: { 200: json(SubmitResponseSchema, 'Sent; poll /tx/{signature}') },
    }),
    async (c) => {
      const { tx } = c.req.valid('json')
      return c.json(
        await submitSponsored(deps, marketSet, { tx, ip: clientIp(c.req.raw.headers) }),
        200,
      )
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/tx/{signature}',
      request: { params: z.object({ signature: SignatureSchema }) },
      responses: { 200: json(TxStatusSchema, 'Transaction status') },
    }),
    async (c) => c.json(await txStatus(ctx, c.req.valid('param').signature), 200),
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/positions/{wallet}',
      request: { params: z.object({ wallet: PubkeySchema }) },
      responses: { 200: json(PositionsResponseSchema, 'Positions and P&L') },
    }),
    async (c) => {
      const wallet = c.req.valid('param').wallet
      // The nights ride along only while My Game-day is on, so the header links it only then. A
      // flag read that fails leaves them out rather than failing the wallet's positions.
      const me = await flagsOf(c).then(
        (f) => f.FLAG_ME,
        () => false,
      )
      const [held, usdcBalance] = await Promise.all([
        me
          ? positionsAndNights(deps.db, wallet)
          : positionsFor(ctx, wallet).then((positions) => ({ positions })),
        usdcBalanceOf(ctx, wallet),
      ])
      return c.json({ wallet, usdcBalance, ...held }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/me/{wallet}',
      request: { params: z.object({ wallet: PubkeySchema }), query: MeQuerySchema },
      responses: { 200: json(MeResponseSchema, 'My Game-day: tonight against the model') },
    }),
    async (c) => {
      const { wallet } = c.req.valid('param')
      const { teams } = c.req.valid('query')
      const body = await meFor(deps.db, {
        wallet,
        teams: teams ?? [],
        now: deps.now(),
        disputeWindow,
      })
      c.header('cache-control', 'no-store')
      return c.json(body, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/faucet',
      request: body(FaucetRequestSchema),
      responses: { 200: json(FaucetResponseSchema, 'mUSDC sent') },
    }),
    async (c) => {
      const { wallet } = c.req.valid('json')
      return c.json(await claimFaucet(deps, wallet, clientIp(c.req.raw.headers)), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/practice',
      responses: { 200: json(PracticeResponseSchema, 'The Practice run in flight and the next') },
    }),
    async (c) => {
      c.header('cache-control', cacheShort)
      return c.json(await practiceFor(deps.db, deps.now()), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/flags',
      responses: { 200: json(FlagsResponseSchema, 'Feature flags; every one is off by default') },
    }),
    async (c) => {
      c.header('cache-control', 'no-store')
      return c.json({ flags: await flagsOf(c) }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/health',
      responses: {
        200: json(HealthSchema, 'Healthy'),
        503: json(HealthSchema, 'Degraded'),
      },
    }),
    async (c) => {
      const timed = async <T>(fn: () => Promise<T>) => {
        const t = performance.now()
        try {
          return { ok: true as const, value: await fn(), ms: Math.round(performance.now() - t) }
        } catch {
          return { ok: false as const, value: null, ms: Math.round(performance.now() - t) }
        }
      }
      const heartbeatRead = timed(() => getHeartbeat(deps.db, 'keeper'))
      const ops = healthOps(heartbeatRead.then((r) => (r.ok ? r.value : null)))
      const [db, rpcSlot, agentRead] = await Promise.all([
        heartbeatRead,
        timed(() => deps.connection.getSlot('confirmed')),
        timed(() => getHeartbeat(deps.db, 'agent')),
      ])
      const heartbeat = db.ok ? db.value : null
      const age = heartbeat
        ? Math.max(0, deps.now() - Math.floor(heartbeat.ts.getTime() / 1000))
        : null
      const keeperOk = age !== null && age <= 120
      const health = {
        ok: db.ok && rpcSlot.ok && keeperOk,
        db: { ok: db.ok, ms: db.ms },
        rpc: { ok: rpcSlot.ok, ms: rpcSlot.ms, slot: rpcSlot.ok ? rpcSlot.value : null },
        keeper: { ok: keeperOk, heartbeatAgeSecs: age },
        version: deps.version,
        ops: await ops,
        // The reference agent's mode, from its own heartbeat; it never changes `ok` (/agent).
        agent: agentBeat(agentRead.ok ? agentRead.value : null, deps.now()),
      }
      c.header('cache-control', 'no-store')
      return health.ok ? c.json(health, 200) : c.json(health, 503)
    },
  )

  return app
}

export type HoragonApiApp = ReturnType<typeof createApp>
