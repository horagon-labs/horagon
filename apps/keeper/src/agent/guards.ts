// The reference agent's in-process state: what it spent per market (the indexer lags, so the
// DB alone can count low), the check that follows each landed swap, the failure streak that
// pauses it, and where the next round starts.
import type { Side } from './decide'

/** Spend and swap count per market, as this process sent them. */
export class SpendBook {
  private readonly byMarket = new Map<string, { spent: bigint; swaps: number }>()

  /** A swap that landed, or may still land: counted either way. */
  record(market: string, amountIn: bigint): void {
    const cur = this.byMarket.get(market) ?? { spent: 0n, swaps: 0 }
    this.byMarket.set(market, { spent: cur.spent + amountIn, swaps: cur.swaps + 1 })
  }

  /** The larger of the DB's count and this process's, for each of spend and swaps. */
  totals(market: string, db?: { spent: bigint; swaps: number }): { spent: bigint; swaps: number } {
    const mine = this.byMarket.get(market) ?? { spent: 0n, swaps: 0 }
    const theirs = db ?? { spent: 0n, swaps: 0 }
    return {
      spent: mine.spent > theirs.spent ? mine.spent : theirs.spent,
      swaps: Math.max(mine.swaps, theirs.swaps),
    }
  }
}

export interface SentSwap {
  gameId: string
  side: Side
  /** The model the swap was sized on, and the YES price before it. */
  model: number
  price: number
}

/**
 * After a swap that landed (or may have), the next read of that market must show the gap it was
 * sized to close no larger, on the same side. The gap is measured against the model the swap was
 * sized on: a model that moved with the game in the meantime is not the agent's doing. A gap that
 * grew means the price moved away from the model after the agent pushed it toward it (a wrong
 * side, a swap that did something else, a trade against it): the market is disabled until a
 * restart by hand (agent.ts `resume` keeps it disabled across a crash or a stall exit).
 */
export class AnomalyWatch {
  private readonly pending = new Map<string, SentSwap>()
  private readonly off = new Set<string>()

  expect(market: string, sent: SentSwap): void {
    this.pending.set(market, sent)
  }

  hasPending(market: string): boolean {
    return this.pending.has(market)
  }

  /**
   * The next price read of `market` (null: it could not price, which proves nothing). Returns
   * the swap that grew the gap, once; the market is then disabled. Any other read clears it.
   */
  check(market: string, price: number | null): SentSwap | null {
    const sent = this.pending.get(market)
    if (!sent) return null
    this.pending.delete(market)
    if (price === null) return null
    const before = sent.model - sent.price
    const after = sent.model - price
    const grew = Math.sign(after) === Math.sign(before) && Math.abs(after) > Math.abs(before)
    if (!grew) return null
    this.off.add(market)
    return sent
  }

  /** Markets with a pending check that this round did not read: dropped. */
  forgetExcept(read: ReadonlySet<string>): void {
    for (const market of [...this.pending.keys()])
      if (!read.has(market)) this.pending.delete(market)
  }

  /** Disables `market` without a check (the markets a run that did not stop cleanly left off). */
  disable(market: string): void {
    this.off.add(market)
  }

  disabled(market: string): boolean {
    return this.off.has(market)
  }

  get disabledMarkets(): string[] {
    return [...this.off]
  }
}

/**
 * Consecutive failed reads and sends. The streak ends only with a round that had none; at
 * `maxFailures` the agent pauses for `pauseSecs` and the streak starts again from 0.
 */
export class FailureGuard {
  private streak = 0
  private until = 0

  constructor(
    readonly maxFailures: number,
    readonly pauseSecs: number,
  ) {}

  get count(): number {
    return this.streak
  }

  /** Unix seconds the pause ends at; 0 when never paused. */
  get pausedUntil(): number {
    return this.until
  }

  paused(now: number): boolean {
    return now < this.until
  }

  /** One more failure; true when it starts a pause. */
  fail(now: number): boolean {
    this.streak++
    if (this.streak < this.maxFailures) return false
    this.streak = 0
    this.until = now + this.pauseSecs
    return true
  }

  /** A round without a failure. */
  clean(): void {
    this.streak = 0
  }
}

/**
 * Where a round starts in its list of markets (read in the same order every round: end_ts, then
 * address). A round can end before its last market (a slow send, the stop signal), so each one
 * starts at the market after the last one the rounds before decided, wrapping around: a market
 * late in the list is not left behind round after round. A round that decides nothing leaves the
 * place where it was.
 */
export class Rotation {
  /** The list of the round that decided `last`, in its order. */
  private order: readonly string[] = []
  private last: string | null = null

  /** The index in `markets` (this round's list) to start at. */
  start(markets: readonly string[]): number {
    if (this.last === null || markets.length === 0) return 0
    const here = markets.indexOf(this.last)
    if (here >= 0) return (here + 1) % markets.length
    // The last market decided is no longer listed (its game ended): the first market after it,
    // in the order it was listed in then, that still is.
    const at = this.order.indexOf(this.last)
    for (let k = 1; k < this.order.length; k++) {
      const i = markets.indexOf(this.order[(at + k) % this.order.length] as string)
      if (i >= 0) return i
    }
    return 0
  }

  /** The round decided `market`; `markets` is that round's list. */
  decided(market: string, markets: readonly string[]): void {
    this.last = market
    this.order = markets
  }
}
