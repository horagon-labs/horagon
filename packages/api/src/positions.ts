// Positions and P&L from indexed balance deltas (spec 8: "a view over trades and
// redeems_claims"). Average-cost basis per (market, side): buying adds cost, selling or
// claiming removes cost pro rata and books the difference as realized P&L, and a YES<->NO
// swap carries the removed cost over to the side bought. Pure and deterministic.
import type { ClaimRow, MarketRow, TradeRow } from '@horagon/db'
import {
  formatAmount,
  type MarketStatus,
  marketKindName,
  type Outcome,
  type Position,
  type Side,
} from '@horagon/sdk'

interface Book {
  shares: bigint
  cost: bigint
  realized: bigint
}

interface Flow {
  market: string
  yes: bigint
  no: bigint
  usdc: bigint
  /** A claim pays only the winning side; its USDC is credited to that side's book. */
  claim: boolean
  /** Block time (ms), slot, signature, instruction index. */
  order: [number, bigint, string, number]
}

const RESOLVED: ReadonlySet<string> = new Set(['finalized', 'recycled'])
const MICROS = 1_000_000n

/** A price in [0, 1] as integer millionths, rounded half up, so value math stays in bigint. */
function toMicros(price: number): bigint {
  return BigInt(Math.round(price * 1_000_000))
}
/** Claims carry no slot: within one second they sort after the trades. */
const NO_SLOT = 2n ** 64n

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Oldest first. Block time has 1 s resolution, so the slot orders flows within a second; block
 * time stays the first key because claims have no slot, and it never decreases from slot to slot.
 */
function flows(trades: TradeRow[], claims: ClaimRow[]): Flow[] {
  const out: Flow[] = [
    ...trades.map(
      (t): Flow => ({
        market: t.market,
        yes: t.yesDelta,
        no: t.noDelta,
        usdc: t.usdcDelta,
        claim: false,
        order: [t.blockTime.getTime(), t.slot, t.sig, t.ixIndex],
      }),
    ),
    ...claims.map(
      (c): Flow => ({
        market: c.market,
        yes: c.yesDelta,
        no: c.noDelta,
        usdc: c.usdcAmount,
        claim: c.kind === 'claim',
        order: [c.blockTime.getTime(), NO_SLOT, c.sig, c.ixIndex],
      }),
    ),
  ]
  return out.sort(
    (a, b) =>
      a.order[0] - b.order[0] ||
      (a.order[1] < b.order[1] ? -1 : a.order[1] > b.order[1] ? 1 : 0) ||
      compareText(a.order[2], b.order[2]) ||
      a.order[3] - b.order[3],
  )
}

function apply(books: { home: Book; away: Book }, f: Flow, winner: Side | null): void {
  const legs: Array<{ side: Side; book: Book; delta: bigint; sold: bigint; removed: bigint }> = [
    { side: 'home', book: books.home, delta: f.yes, sold: 0n, removed: 0n },
    { side: 'away', book: books.away, delta: f.no, sold: 0n, removed: 0n },
  ]
  for (const leg of legs) {
    if (leg.delta >= 0n) continue
    leg.sold = -leg.delta
    // Cost leaves with the shares that carry it. Shares the book does not hold (a sell ordered
    // before its buy within one slot, or tokens from outside Horagon) carry none, but they still
    // leave the book, and their proceeds are booked as realized below.
    if (leg.book.shares > 0n) {
      // biome-ignore lint/complexity/useMathMinMax: bigint operands; Math.min takes numbers only
      const covered = leg.sold > leg.book.shares ? leg.book.shares : leg.sold
      leg.removed = (leg.book.cost * covered) / leg.book.shares
      leg.book.cost -= leg.removed
    }
    leg.book.shares -= leg.sold
  }
  const removed = legs.reduce((n, l) => n + l.removed, 0n)
  const gained = legs.filter((l) => l.delta > 0n)
  const totalGained = gained.reduce((n, l) => n + l.delta, 0n)
  if (totalGained === 0n) {
    // Sell, redeem or claim: book USDC in against the cost taken off each side.
    const totalSold = legs.reduce((n, l) => n + l.sold, 0n)
    for (const leg of legs) {
      const credit = f.claim
        ? leg.side === winner
          ? f.usdc
          : 0n
        : totalSold === 0n
          ? 0n
          : (f.usdc * leg.sold) / totalSold
      leg.book.realized += credit - leg.removed
    }
    return
  }
  // Buy or YES<->NO: the new shares carry the USDC paid plus any cost moved across.
  const basis = (f.usdc < 0n ? -f.usdc : 0n) + removed
  let assigned = 0n
  gained.forEach((leg, i) => {
    const part = i === gained.length - 1 ? basis - assigned : (basis * leg.delta) / totalGained
    leg.book.shares += leg.delta
    leg.book.cost += part
    assigned += part
  })
}

export interface PositionInputs {
  trades: TradeRow[]
  claims: ClaimRow[]
  markets: MarketRow[]
  /** Latest YES price per market (indexed), if any. */
  prices: Map<string, number>
}

export function aggregatePositions(input: PositionInputs): Position[] {
  const meta = new Map(input.markets.map((m) => [m.pubkey, m]))
  const byMarket = new Map<string, { home: Book; away: Book }>()
  for (const f of flows(input.trades, input.claims)) {
    const outcome = meta.get(f.market)?.outcome
    const winner: Side | null = outcome === 'yes' ? 'home' : outcome === 'no' ? 'away' : null
    let b = byMarket.get(f.market)
    if (!b) {
      b = {
        home: { shares: 0n, cost: 0n, realized: 0n },
        away: { shares: 0n, cost: 0n, realized: 0n },
      }
      byMarket.set(f.market, b)
    }
    apply(b, f, winner)
  }
  const out: Position[] = []
  for (const [market, books] of byMarket) {
    const m = meta.get(market)
    if (!m) continue
    const resolved = RESOLVED.has(m.status) && (m.outcome === 'yes' || m.outcome === 'no')
    const yesPrice = resolved
      ? m.outcome === 'yes'
        ? 1
        : 0
      : (input.prices.get(market) ?? m.initialPriceBps / 10_000)
    for (const side of ['home', 'away'] as Side[]) {
      const book = books[side]
      if (book.shares === 0n && book.realized === 0n && book.cost === 0n) continue
      const price = side === 'home' ? yesPrice : 1 - yesPrice
      // A book can dip below zero (shares it never saw bought); show it as holding none.
      const shares = book.shares > 0n ? book.shares : 0n
      const value = (shares * toMicros(price)) / MICROS
      const winning = resolved && (side === 'home') === (m.outcome === 'yes')
      out.push({
        market,
        gameId: m.gameId,
        kind: marketKindName(m.kind),
        side,
        shares: formatAmount(shares),
        costUsdc: formatAmount(book.cost),
        valueUsdc: formatAmount(value),
        pnlUsdc: formatAmount(value - book.cost + book.realized),
        price: resolved ? price : input.prices.get(market) === undefined ? null : price,
        marketStatus: m.status as MarketStatus,
        outcome: (m.outcome as Outcome | null) ?? null,
        claimable: winning && shares > 0n,
      })
    }
  }
  return out.sort((a, b) => a.market.localeCompare(b.market) || a.side.localeCompare(b.side))
}
