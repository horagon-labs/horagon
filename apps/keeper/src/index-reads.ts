// The keeper's index reads (the indexer's and the ATA watch's) over an ordered list of RPC
// endpoints: HORAGON_INDEX_RPC_URL, HORAGON_INDEX_RPC_URL_2, HORAGON_INDEX_FALLBACK_RPC_URL and
// HORAGON_RPC_URL, the ones set and cluster-checked (`indexEndpoints` in config.ts). Each has its
// own IndexPace: back-off, signature spacing, transaction budget. A read goes to the first
// endpoint that is not paused; when that endpoint fails it (a rate limit, an auth refusal, a 5xx,
// a timeout, an unreachable host, a request it refuses or an answer that cannot be read), it is
// paused with back-off and the same read goes to the next one, so a pass never loses what it has
// read and the cursors stay where the reads left them. A paused endpoint is tried again once its
// back-off ends; the first one up in the list is always preferred. Moving away from the first
// logs and pages `index-failover`; only when every endpoint has been down for more than 15 min
// does `index-rate-limited` page. Logs carry the endpoint's variable name and host, never its
// URL (a key may sit in its path or query) or its headers.
import { errorSummary } from '@horagon/sdk'
import type { Connection } from '@solana/web3.js'
import type { Logger } from 'pino'
import type { Alerter } from './alerts'
import {
  type IndexPace,
  isRateLimited,
  MarketMarks,
  type PaceSource,
  RATE_LIMIT_PAGE_AFTER_MS,
} from './index-pace'

/** Why an endpoint failed a read; null when the failure is not the endpoint's. */
export type ReadFailure =
  | 'rate-limit'
  | 'auth'
  | 'refused'
  | 'server'
  | 'timeout'
  | 'unreachable'
  | 'bad-answer'

const AUTH_CODES = new Set([401, 403, -16401])
/** JSON-RPC "method not found": the endpoint does not serve the method. */
const REFUSED_CODES = new Set([-32601])
const AUTH_TEXT = /\bunauthori[sz]ed\b|not available for anonymous access|invalid api key/i
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
])
/** web3.js puts an HTTP status first in the message of a request the server did not answer OK. */
const HTTP_STATUS = /^(\d{3}) /

function statusFailure(status: number): ReadFailure | null {
  if (AUTH_CODES.has(status)) return 'auth'
  if (REFUSED_CODES.has(status)) return 'refused'
  if (status >= 500 && status <= 599) return 'server'
  if (status >= 400 && status <= 499) return 'refused'
  return null
}

/**
 * Whether `err` is the endpoint failing a read, and how: a rate limit (`isRateLimited`), an auth
 * refusal (HTTP 401/403, JSON-RPC -16401, "Unauthorized"), a request it refuses (another HTTP 4xx,
 * JSON-RPC -32601), a 5xx, a timeout, an unreachable host, or a batch answered with something
 * that is not a list. Anything else (a JSON-RPC error about the request, a bare network error, a
 * database error) is null: the caller handles it as before.
 */
export function readFailure(err: unknown): ReadFailure | null {
  if (isRateLimited(err)) return 'rate-limit'
  let cur: unknown = err
  for (let depth = 0; depth < 4 && cur !== null && cur !== undefined; depth++) {
    if (typeof cur !== 'object') return null
    const o = cur as {
      name?: unknown
      code?: unknown
      status?: unknown
      statusCode?: unknown
      message?: unknown
      cause?: unknown
    }
    if (o.name === 'TimeoutError') return 'timeout'
    for (const v of [o.code, o.status, o.statusCode]) {
      if (typeof v === 'number') {
        const f = statusFailure(v)
        if (f) return f
      }
      if (typeof v === 'string') {
        if (TIMEOUT_CODES.has(v)) return 'timeout'
        if (UNREACHABLE_CODES.has(v)) return 'unreachable'
      }
    }
    if (typeof o.message === 'string') {
      const http = HTTP_STATUS.exec(o.message)
      const f = http ? statusFailure(Number(http[1])) : null
      if (f) return f
      if (AUTH_TEXT.test(o.message)) return 'auth'
      if (/aborted due to timeout/i.test(o.message)) return 'timeout'
      if (o.name === 'TypeError' && /\.map is not a function/.test(o.message)) return 'bad-answer'
    }
    cur = o.cause
  }
  return null
}

/** One endpoint of the list. */
export interface IndexEndpoint<C> {
  /** The variable it comes from (HORAGON_INDEX_RPC_URL, ...), for logs and pages. */
  name: string
  /** Its host only: the rest of the URL may carry a key. */
  host: string
  connection: () => C
  pace: IndexPace
}

/** Every endpoint is paused: the pass stops (its reads so far are kept). */
export class EveryEndpointDown extends Error {
  override name = 'EveryEndpointDown'
  constructor(readonly error: unknown) {
    super(`every index RPC is paused: ${errorSummary(error).message}`)
  }
}

/** The transaction budget would come later than the caller can wait: nothing was read. */
export const NOT_NOW: unique symbol = Symbol('not now')

/** The reads of one indexer or ATA watch pass. */
export interface IndexPass<C> {
  /** An account read (getMultipleAccountsInfo), not spaced. */
  accounts<T>(fn: (c: C) => Promise<T>): Promise<T>
  /** A getSignaturesForAddress call, spaced on the endpoint's signature clock. */
  signatures<T>(fn: (c: C) => Promise<T>): Promise<T>
  /**
   * A read of `n` getTransaction entries (a batch, or one call), from the endpoint's transaction
   * budget, waited for at most `maxWaitMs`; NOT_NOW when it would come later.
   */
  transactions<T>(
    n: number,
    maxWaitMs: number,
    fn: (c: C) => Promise<T>,
  ): Promise<T | typeof NOT_NOW>
  /** The pass is over: each endpoint that answered and never failed in it starts its back-off over. */
  end(): void
}

/** A pass straight on one connection: no pace, no failover (the indexer without IndexReads). */
export function directPass<C>(connection: C): IndexPass<C> {
  return {
    accounts: (fn) => fn(connection),
    signatures: (fn) => fn(connection),
    transactions: (_n, _w, fn) => fn(connection),
    end: () => {},
  }
}

type Method = 'accounts' | 'signatures' | 'transactions'

export interface IndexReadsOptions<C> {
  /** In order of preference; at least one. */
  endpoints: ReadonlyArray<IndexEndpoint<C>>
  log: Logger
  alerts: Alerter
  /** Wall clock in ms; defaults to Date.now. */
  clock?: () => number
  /** Each read that answered or failed (the index loop's liveness). */
  onRead?: () => void
}

export class IndexReads<C = Connection> {
  /** Which markets changed, for the indexer (whatever endpoint read them). */
  readonly marks = new MarketMarks()
  readonly clock: () => number
  private readonly endpoints: ReadonlyArray<IndexEndpoint<C>>
  /** The endpoint of the last read. */
  private active: IndexEndpoint<C> | undefined
  /** Why the last endpoint to fail did (for the failover page). */
  private lastFailure: { name: string; failure: ReadFailure } | undefined
  /** Since when (ms) every endpoint has been paused, until a clean pass; null when not. */
  private downSince: number | null = null

  constructor(private readonly opts: IndexReadsOptions<C>) {
    if (opts.endpoints.length === 0) throw new Error('IndexReads needs at least one endpoint')
    this.endpoints = opts.endpoints
    this.clock = opts.clock ?? Date.now
  }

  /** The endpoints, in order: their names and hosts (for the start-up log). */
  describe(): Array<{ indexRpc: string; indexRpcHost: string }> {
    return this.endpoints.map((e) => ({ indexRpc: e.name, indexRpcHost: e.host }))
  }

  /** The first endpoint that is not paused. */
  private up(): IndexEndpoint<C> | undefined {
    return this.endpoints.find((e) => !e.pace.held())
  }

  /** A pass of `source`'s reads; null when every endpoint is paused (the pass reads nothing). */
  async begin(source: PaceSource): Promise<IndexPass<C> | null> {
    if (!this.up()) {
      this.downSince ??= this.clock()
      await this.pageIfLong()
      return null
    }
    const ok = new Set<IndexEndpoint<C>>()
    const failed = new Set<IndexEndpoint<C>>()
    const read = <T>(method: Method, fn: (c: C) => Promise<T>, budget?: [number, number]) =>
      this.read(source, ok, failed, method, fn, budget)
    return {
      accounts: (fn) => read('accounts', fn) as Promise<never>,
      signatures: (fn) => read('signatures', fn) as Promise<never>,
      transactions: (n, maxWaitMs, fn) => read('transactions', fn, [n, maxWaitMs]),
      end: () => {
        let cleaned = false
        for (const e of ok) {
          if (failed.has(e)) continue
          e.pace.clean()
          cleaned = true
        }
        if (cleaned) this.downSince = null
      },
    }
  }

  private async read<T>(
    source: PaceSource,
    ok: Set<IndexEndpoint<C>>,
    failed: Set<IndexEndpoint<C>>,
    method: Method,
    fn: (c: C) => Promise<T>,
    budget?: [number, number],
  ): Promise<T | typeof NOT_NOW> {
    let last: unknown
    for (;;) {
      const e = this.up()
      if (!e) {
        this.downSince ??= this.clock()
        await this.pageIfLong()
        throw new EveryEndpointDown(last)
      }
      await this.use(e)
      if (method === 'signatures') await e.pace.spaceSignatures()
      if (budget && !(await e.pace.takeTransactions(budget[0], budget[1]))) return NOT_NOW
      try {
        const value = await fn(e.connection())
        ok.add(e)
        return value
      } catch (err) {
        const failure = readFailure(err)
        if (!failure) throw err
        failed.add(e)
        last = err
        this.lastFailure = { name: e.name, failure }
        e.pace.down(source, err, failure, { name: e.name, host: e.host })
      } finally {
        this.opts.onRead?.()
      }
    }
  }

  /** `e` serves the next read: logs a change, and pages one away from the first endpoint. */
  private async use(e: IndexEndpoint<C>): Promise<void> {
    const prev = this.active
    if (prev === e) return
    this.active = e
    if (!prev && e === this.endpoints[0]) return
    const why = this.lastFailure && prev?.name === this.lastFailure.name ? this.lastFailure : null
    this.opts.log.info(
      {
        ...(prev ? { from: prev.name } : {}),
        to: e.name,
        indexRpcHost: e.host,
        ...(why ? { failure: why.failure } : {}),
      },
      'index reads moved to another RPC',
    )
    if (e === this.endpoints[0]) return
    await this.opts.alerts.send(
      'index-failover',
      `Index reads moved from ${prev ? `${prev.name} (${prev.host})` : 'the first index RPC'} to ${e.name} (${e.host})${why ? `: ${why.failure}` : ''}. The first one is tried again after its back-off (runbook L)`,
    )
  }

  private async pageIfLong(): Promise<void> {
    const now = this.clock()
    if (this.downSince === null || now - this.downSince <= RATE_LIMIT_PAGE_AFTER_MS) return
    const mins = Math.floor((now - this.downSince) / 60_000)
    const hosts = this.endpoints.map((e) => e.host).join(', ')
    await this.opts.alerts.send(
      'index-rate-limited',
      `Every index RPC (${hosts}) has failed the keeper's index reads for ${mins} min (each tried again after up to 10 min): trades, claims and prices are not being indexed. Wait, or set HORAGON_INDEX_RPC_URL (runbook L)`,
    )
  }
}
