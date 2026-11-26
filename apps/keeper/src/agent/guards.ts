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
  /**
   * The swap's time, Unix seconds: the read its price before came from (the round's snapshot),
   * so at or before the swap itself. A trade by another wallet from then on moved the pool too.
   */
  at: number
}

/**
 * How long a market is held after a read showed its gap grown while the database holds no trade
 * by another wallet since the swap. The agent reads those trades from the indexer, which stores a
 * trade one keeper round after it lands at best (5 s), and later while the keeper waits on a send
 * (up to 90 s each, executor.ts): a counter-trade that landed before the read may not be stored
 * yet. The market sends nothing while held.
 */
export const ANOMALY_HOLD_SECS = 120

/** A read's verdict on a market's pending check (AnomalyWatch.check). */
export type CheckResult =
  /** Nothing was pending, or the read cleared it. */
  | { state: 'none' }
  /**
   * The gap grew and no other trade since the swap is stored yet: the check stays pending until
   * `until` (Unix seconds) and the market sends nothing. `first` on the read that started it.
   */
  | { state: 'held'; sent: SentSwap; until: number; first: boolean }
  /** The gap is still grown at the end of the hold: the market is now disabled. */
  | { state: 'disabled'; sent: SentSwap }

const NONE: CheckResult = { state: 'none' }

/** The gap the swap was sized to close is larger now, on the same side. */
function gapGrew(sent: SentSwap, price: number): boolean {
  const before = sent.model - sent.price
  const after = sent.model - price
  return Math.sign(after) === Math.sign(before) && Math.abs(after) > Math.abs(before)
}

/**
 * After a swap that landed (or may have), the next read of that market must show the gap it was
 * sized to close no larger, on the same side. The gap is measured against the model the swap was
 * sized on: a model that moved with the game in the meantime is not the agent's doing. A gap that
 * grew means the price moved away from the model after the agent pushed it toward it (a wrong
 * side, a swap that did something else), or that another wallet traded the other way. A trade by
 * another wallet at or after the swap clears the check (`clearAfter`): the price move is then not
 * the agent's alone, and one counter-trade must not switch the agent off a market. Since the
 * indexer stores that trade late, a grown gap first holds the market for ANOMALY_HOLD_SECS; a
 * trade stored in that time clears it, and a gap still grown at its end disables the market until
 * a restart by hand (agent.ts `resume` keeps it disabled across a crash or a stall exit).
 */
export class AnomalyWatch {
  /** `heldSince`: the read that first found the gap grown (Unix seconds). */
  private readonly pending = new Map<string, SentSwap & { heldSince?: number }>()
  private readonly off = new Set<string>()

  expect(market: string, sent: SentSwap): void {
    this.pending.set(market, sent)
  }

  hasPending(market: string): boolean {
    return this.pending.has(market)
  }

  /** The market is held: its gap grew, and the check waits for the indexer (check). */
  held(market: string): boolean {
    return this.pending.get(market)?.heldSince !== undefined
  }

  /**
   * Another wallet's newest trade on `market` was at `tradeAt` (Unix seconds): a pending check
   * (held or not) whose swap came at or before it is cleared, without disabling the market. True
   * when it cleared one.
   */
  clearAfter(market: string, tradeAt: number): boolean {
    const sent = this.pending.get(market)
    if (!sent || tradeAt < sent.at) return false
    this.pending.delete(market)
    return true
  }

  /** The time of the oldest swap still checked, held ones included; null when none is. */
  get oldestPendingAt(): number | null {
    let oldest: number | null = null
    for (const { at } of this.pending.values()) if (oldest === null || at < oldest) oldest = at
    return oldest
  }

  /**
   * A price read of `market` at `now` (Unix seconds; null price: it could not price, which proves
   * nothing). A read that shows the gap no larger clears the check. A grown gap holds the market
   * for ANOMALY_HOLD_SECS from the read that first found it; a read at or after the hold's end
   * that still finds it grown disables the market, once.
   */
  check(market: string, price: number | null, now: number): CheckResult {
    const pending = this.pending.get(market)
    if (!pending) return NONE
    const { heldSince, ...sent } = pending
    if (price === null || !gapGrew(sent, price)) {
      this.pending.delete(market)
      return NONE
    }
    if (heldSince === undefined) {
      this.pending.set(market, { ...sent, heldSince: now })
      return { state: 'held', sent, until: now + ANOMALY_HOLD_SECS, first: true }
    }
    const until = heldSince + ANOMALY_HOLD_SECS
    if (now < until) return { state: 'held', sent, until, first: false }
    this.pending.delete(market)
    this.off.add(market)
    return { state: 'disabled', sent }
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
