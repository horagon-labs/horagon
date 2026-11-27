// The pace of the keeper's index reads (the indexer's and the ATA watch's) on one RPC endpoint
// (incident of 2026-11-25: a public RPC held the keeper's IP in a per-method rate limit that its
// own reads every 5 s kept alive). Each endpoint of `IndexReads` (`index-reads.ts`) has one: a
// failure of the endpoint pauses its reads with exponential back-off and jitter, signature reads
// are spaced, and transaction reads (each entry of a batch) come out of a budget per 10 s, for
// the indexer and the ATA watch together. `MarketMarks` keeps, for the indexer, which markets
// changed: a market is asked for its signatures only when its account or its mints changed or
// its sweep is due. Everything here is in memory: a restart indexes every market once and starts
// with no pause. It never sleeps through a pause: a held pass returns at once.
import { errorSummary } from '@horagon/sdk'
import type { Logger } from 'pino'

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
/**
 * getTransaction entries (each entry of a batch counts) in any 10 s, from the indexer and the ATA
 * watch together: the RPC limits each method apart, and may count every entry of a batch.
 */
export const TRANSACTIONS_PER_WINDOW = 30
export const TRANSACTION_WINDOW_MS = 10_000
/** What each getTransaction entry costs of the transaction clock: the next read waits for it. */
export const TRANSACTION_SPACING_MS = 350
/** The most getTransaction entries in one batch of the indexer. */
export const TRANSACTION_CHUNK = 10
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
  /** Wall clock in ms; defaults to Date.now. */
  clock?: () => number
  /** In [0, 1); defaults to Math.random. */
  random?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** The pace of one endpoint's index reads. */
export class IndexPace {
  readonly clock: () => number
  private readonly random: () => number
  private readonly sleep: (ms: number) => Promise<void>
  /** Failures since the last clean pass. */
  private attempt = 0
  /** Reads are held until this time (ms). */
  private until = 0
  /** When (ms) the last call of each spaced method was made. */
  private readonly lastCall = { signatures: Number.NEGATIVE_INFINITY }
  /** getTransaction entries taken in the last window: when (ms) and how many. */
  private taken: Array<{ at: number; n: number }> = []
  /** No getTransaction read before this time (ms): the last one's entries times the spacing. */
  private transactionsFrom = Number.NEGATIVE_INFINITY

  constructor(private readonly opts: PaceOptions) {
    this.clock = opts.clock ?? Date.now
    this.random = opts.random ?? Math.random
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  }

  /** True while a pause holds this endpoint's reads. */
  held(): boolean {
    return this.clock() < this.until
  }

  /**
   * A read failed on this endpoint (a rate limit, an auth refusal, a 5xx, a timeout...): pause
   * its reads, log once with the delay and the endpoint's name and host. Returns the delay.
   */
  down(
    source: PaceSource,
    err: unknown,
    failure = 'rate-limit',
    endpoint?: { name: string; host: string },
  ): number {
    const now = this.clock()
    const delayMs = backoffDelayMs(this.attempt, this.random)
    this.attempt++
    this.until = now + delayMs
    this.opts.log.warn(
      {
        source,
        ...(endpoint ? { indexRpc: endpoint.name, indexRpcHost: endpoint.host } : {}),
        failure,
        delayMs,
        attempt: this.attempt,
        error: errorSummary(err).message,
      },
      'index RPC read failed; pausing its reads',
    )
    return delayMs
  }

  /** A pass whose reads on this endpoint all answered: the next failure starts the back-off over. */
  clean(): void {
    this.attempt = 0
  }

  /** Waits until the last getSignaturesForAddress is at least SIGNATURES_SPACING_MS old. */
  spaceSignatures(): Promise<void> {
    return this.space('signatures', SIGNATURES_SPACING_MS)
  }

  private async space(method: 'signatures', spacingMs: number): Promise<void> {
    // At most one spacing: a clock stepped back must not hold the reads for the step.
    const wait = Math.min(spacingMs, this.lastCall[method] + spacingMs - this.clock())
    if (wait > 0) await this.sleep(wait)
    this.lastCall[method] = this.clock()
  }

  /**
   * Takes `n` getTransaction entries (a batch of n, or one call) from the budget: no more than
   * TRANSACTIONS_PER_WINDOW in any TRANSACTION_WINDOW_MS, and TRANSACTION_SPACING_MS of the
   * transaction clock per entry. Waits for them when that is at most `maxWaitMs`; otherwise
   * takes nothing and returns false, and the caller stops where it is.
   */
  async takeTransactions(n: number, maxWaitMs: number): Promise<boolean> {
    let wait = this.transactionsReadyAt(n, this.clock()) - this.clock()
    if (wait > TRANSACTION_WINDOW_MS + TRANSACTION_CHUNK * TRANSACTION_SPACING_MS) {
      // Longer than the budget can ever ask: the clock stepped back. Start the budget over.
      this.taken = []
      this.transactionsFrom = Number.NEGATIVE_INFINITY
      wait = 0
    }
    if (wait > maxWaitMs) return false
    if (wait > 0) await this.sleep(wait)
    const at = this.clock()
    this.taken.push({ at, n })
    this.transactionsFrom = at + n * TRANSACTION_SPACING_MS
    return true
  }

  /** The first time (ms) `n` more entries fit both the spacing and the window. */
  private transactionsReadyAt(n: number, now: number): number {
    this.taken = this.taken.filter((e) => e.at > now - TRANSACTION_WINDOW_MS)
    let ready = Math.max(now, this.transactionsFrom)
    // Entries still in the window that would end at `ready`; the oldest leave it first.
    let inWindow = this.taken
      .filter((e) => e.at > ready - TRANSACTION_WINDOW_MS)
      .reduce((s, e) => s + e.n, 0)
    for (const e of this.taken) {
      if (inWindow + n <= TRANSACTIONS_PER_WINDOW) break
      if (e.at <= ready - TRANSACTION_WINDOW_MS) continue
      inWindow -= e.n
      ready = Math.max(ready, e.at + TRANSACTION_WINDOW_MS)
    }
    return ready
  }
}

/**
 * Per market, for the indexer: the hash of its account and mints and when (s) it was last indexed
 * in full, or read in part (`partial`: due on every pass until it is read in full).
 */
export class MarketMarks {
  private readonly marks = new Map<
    string,
    { hash: string | undefined; at: number; partial?: true }
  >()

  /**
   * Whether `market` needs its signatures read: never indexed in full since start, its account
   * data changed (`hash`, undefined when not read this pass), or `sweepSecs` have passed.
   */
  due(market: string, hash: string | undefined, sweepSecs: number, nowSecs: number): boolean {
    const mark = this.marks.get(market)
    if (!mark || mark.partial) return true
    if (hash !== undefined && hash !== mark.hash) return true
    return nowSecs - mark.at >= sweepSecs
  }

  /** Indexed in full with its account data at `hash`. */
  indexed(market: string, hash: string | undefined, nowSecs: number): void {
    this.marks.set(market, { hash, at: nowSecs })
  }

  /**
   * Read in part at `nowSecs` (the transaction budget ran out): due on the next passes, after
   * the markets that have waited longer, until it is read in full.
   */
  partial(market: string, nowSecs: number): void {
    this.marks.set(market, { hash: undefined, at: nowSecs, partial: true })
  }

  /** Not indexed in full (a stop, a failure): due on the next pass, first. */
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
