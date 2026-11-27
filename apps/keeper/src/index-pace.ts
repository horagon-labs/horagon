// The pace of the indexer's and the ATA watch's RPC reads (incident of 2026-11-25: a public RPC
// held the keeper's IP in a per-method rate limit that its own reads every 5 s kept alive).
// One object, made once in `main.ts` and shared by both: a rate limit on any of their reads
// pauses them all with exponential back-off and jitter, and pages `index-rate-limited` once the
// pause has lasted more than 15 min; signature and transaction reads are spaced; and a market
// is asked for its signatures only when its account or its mints changed or its sweep is due.
// Everything here is in memory: a restart indexes every market once and starts with no pause.
// It never sleeps through a pause: a held pass returns at once, so the tick keeps its own
// cadence.
import { errorSummary } from '@horagon/sdk'
import type { Logger } from 'pino'
import type { Alerter } from './alerts'

/** Back-off of a rate limit: 30 s doubling to 10 min, minus up to 20% of jitter. */
export const BACKOFF = { baseMs: 30_000, capMs: 600_000, jitter: 0.2 }
/** A pause streak longer than this pages a person. */
export const RATE_LIMIT_PAGE_AFTER_MS = 15 * 60_000
/**
 * The least time between two getSignaturesForAddress calls, from the indexer and the ATA watch
 * together: at most 29 in any 10 s. The public devnet RPC allows 40 calls of one method per 10 s
 * per IP, and that limit is the one behind the incident; the margin covers a restart, which
 * forgets the last call.
 */
export const SIGNATURES_SPACING_MS = 350
/** The same for the ATA watch's getTransaction calls, which the RPC counts apart. */
export const TRANSACTION_SPACING_MS = 350
/** After this long into a pass no further market is started; the rest go first next pass. */
export const PASS_BUDGET_MS = 3_000
/** A market's signatures are read at least this often even when its account did not change. */
export const SWEEP_SECS = { open: 60, closed: 300 }

export type PaceSource = 'index' | 'ata-watch'

/** JSON-RPC codes some nodes answer a rate limit with. */
const RATE_LIMIT_CODES = new Set([429, -32005])
const RATE_LIMIT_TEXT = /\b429\b|too many requests/i

/**
 * Whether `err` is a rate limit: HTTP 429 (web3.js puts the status at the start of the message),
 * a JSON-RPC code 429 or -32005, or a message saying "Too many requests", on the error or its
 * `cause` chain.
 */
export function isRateLimited(err: unknown): boolean {
  let cur: unknown = err
  for (let depth = 0; depth < 4 && cur !== null && cur !== undefined; depth++) {
    if (typeof cur === 'string') return RATE_LIMIT_TEXT.test(cur)
    if (typeof cur !== 'object') return false
    const o = cur as { code?: unknown; status?: unknown; message?: unknown; cause?: unknown }
    for (const v of [o.code, o.status]) {
      if (typeof v === 'number' && RATE_LIMIT_CODES.has(v)) return true
      if (typeof v === 'string' && RATE_LIMIT_CODES.has(Number(v))) return true
    }
    if (typeof o.message === 'string' && RATE_LIMIT_TEXT.test(o.message)) return true
    cur = o.cause
  }
  return false
}

/** The pause after `attempt` rate limits in a row: within [80%, 100%] of the nominal delay. */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const nominal = Math.min(BACKOFF.capMs, BACKOFF.baseMs * 2 ** attempt)
  const r = Math.min(Math.max(random(), 0), 1)
  return Math.round(nominal * (1 - BACKOFF.jitter * r))
}

export interface PaceOptions {
  log: Logger
  alerts: Alerter
  /** Wall clock in ms; defaults to Date.now. */
  clock?: () => number
  /** In [0, 1); defaults to Math.random. */
  random?: () => number
  sleep?: (ms: number) => Promise<void>
}

export class IndexPace {
  readonly clock: () => number
  private readonly random: () => number
  private readonly sleep: (ms: number) => Promise<void>
  /** Rate limits since the last clean pass. */
  private attempt = 0
  /** Reads are held until this time (ms). */
  private until = 0
  /** The first rate limit since the last clean pass; null when there is none. */
  private since: number | null = null
  /** When (ms) the last call of each spaced method was made. */
  private readonly lastCall = {
    signatures: Number.NEGATIVE_INFINITY,
    transaction: Number.NEGATIVE_INFINITY,
  }
  /** Per market: the hash of its account and mints and when (s) it was last indexed in full. */
  private readonly marks = new Map<string, { hash: string | undefined; at: number }>()

  constructor(private readonly opts: PaceOptions) {
    this.clock = opts.clock ?? Date.now
    this.random = opts.random ?? Math.random
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  }

  /** True while a pause holds reads; pages if the streak has lasted too long. */
  async held(_source: PaceSource): Promise<boolean> {
    const now = this.clock()
    if (now >= this.until) return false
    await this.pageIfLong(now)
    return true
  }

  /** A read was rate-limited: pause all reads, log once with the delay. Returns the delay. */
  async rateLimited(source: PaceSource, err: unknown): Promise<number> {
    const now = this.clock()
    this.since ??= now
    const delayMs = backoffDelayMs(this.attempt, this.random)
    this.attempt++
    this.until = now + delayMs
    this.opts.log.warn(
      { source, delayMs, attempt: this.attempt, error: errorSummary(err).message },
      'RPC rate-limited index reads; pausing them',
    )
    await this.pageIfLong(now)
    return delayMs
  }

  /** A pass whose reads all answered: the next rate limit starts the back-off over. */
  clean(): void {
    this.attempt = 0
    this.since = null
  }

  private async pageIfLong(now: number): Promise<void> {
    if (this.since === null || now - this.since <= RATE_LIMIT_PAGE_AFTER_MS) return
    const mins = Math.floor((now - this.since) / 60_000)
    await this.opts.alerts.send(
      'index-rate-limited',
      `The RPC has rate-limited the keeper's index reads for ${mins} min (paused up to 10 min between tries): trades, claims and prices are not being indexed. Wait, or set HORAGON_INDEX_RPC_URL (runbook)`,
    )
  }

  /** Waits until the last getSignaturesForAddress is at least SIGNATURES_SPACING_MS old. */
  spaceSignatures(): Promise<void> {
    return this.space('signatures', SIGNATURES_SPACING_MS)
  }

  /** Waits until the last getTransaction is at least TRANSACTION_SPACING_MS old. */
  spaceTransactions(): Promise<void> {
    return this.space('transaction', TRANSACTION_SPACING_MS)
  }

  private async space(method: 'signatures' | 'transaction', spacingMs: number): Promise<void> {
    const wait = this.lastCall[method] + spacingMs - this.clock()
    if (wait > 0) await this.sleep(wait)
    this.lastCall[method] = this.clock()
  }

  /**
   * Whether `market` needs its signatures read: never indexed in full since start, its account
   * data changed (`hash`, undefined when not read this pass), or `sweepSecs` have passed.
   */
  due(market: string, hash: string | undefined, sweepSecs: number, nowSecs: number): boolean {
    const mark = this.marks.get(market)
    if (!mark) return true
    if (hash !== undefined && hash !== mark.hash) return true
    return nowSecs - mark.at >= sweepSecs
  }

  /** Indexed in full with its account data at `hash`. */
  indexed(market: string, hash: string | undefined, nowSecs: number): void {
    this.marks.set(market, { hash, at: nowSecs })
  }

  /** Not indexed in full (a stop, a failure): due on the next pass. */
  forget(market: string): void {
    this.marks.delete(market)
  }

  lastIndexedAt(market: string): number {
    return this.marks.get(market)?.at ?? Number.NEGATIVE_INFINITY
  }

  /** Drops the markets that are no longer indexable. */
  retain(markets: ReadonlySet<string>): void {
    for (const k of this.marks.keys()) if (!markets.has(k)) this.marks.delete(k)
  }
}
