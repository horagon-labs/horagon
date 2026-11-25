import type { ClaimRow, MarketRow, TradeRow } from '@horagon/db'
import { describe, expect, it } from 'vitest'
import { aggregatePositions } from '../src/positions'

const M = 'Mkt1111111111111111111111111111111111111111'
const W = 'Wal1111111111111111111111111111111111111111'
const U = 1_000_000n // 1 mUSDC / 1 share in base units

function market(patch: Partial<MarketRow> = {}): MarketRow {
  return {
    pubkey: M,
    gameId: 'nba-1',
    kind: 0,
    marketId: '1',
    gameMarketPda: 'g',
    yesMint: 'y',
    noMint: 'n',
    initialPriceBps: 5000,
    endTs: new Date(0),
    seedAmount: 0n,
    status: 'open',
    outcome: null,
    evidenceHash: null,
    challengeCount: 0,
    externalLp: false,
    createSig: null,
    haltSig: null,
    proposeSig: null,
    finalizeSig: null,
    recycleSig: null,
    proposedAt: null,
    finalizedAt: null,
    recycledAt: null,
    indexCursor: null,
    updatedAt: new Date(0),
    ...patch,
  } as MarketRow
}

let n = 0
function trade(usdc: bigint, yes: bigint, no: bigint): TradeRow {
  n++
  return {
    sig: `s${n}`.padEnd(88, 'x'),
    ixIndex: 0,
    market: M,
    wallet: W,
    direction: 'x',
    usdcAmount: usdc < 0n ? -usdc : usdc,
    usdcDelta: usdc,
    yesDelta: yes,
    noDelta: no,
    fee: 0n,
    slot: BigInt(n),
    blockTime: new Date(n * 1000),
    botMemo: false,
  }
}

function claim(kind: 'claim' | 'redeem', usdc: bigint, yes: bigint, no: bigint): ClaimRow {
  n++
  return {
    sig: `c${n}`.padEnd(88, 'x'),
    ixIndex: 0,
    market: M,
    wallet: W,
    kind,
    usdcAmount: usdc,
    yesDelta: yes,
    noDelta: no,
    blockTime: new Date(n * 1000),
  }
}

describe('aggregatePositions', () => {
  it('values an open buy at the latest price', () => {
    const [p] = aggregatePositions({
      trades: [trade(-10n * U, 20n * U, 0n)],
      claims: [],
      markets: [market()],
      prices: new Map([[M, 0.6]]),
    })
    expect(p).toMatchObject({
      side: 'home',
      shares: '20',
      costUsdc: '10',
      valueUsdc: '12',
      pnlUsdc: '2',
      price: 0.6,
    })
  })

  it('falls back to the initial price, reported as null, before any price point', () => {
    const [p] = aggregatePositions({
      trades: [trade(-10n * U, 20n * U, 0n)],
      claims: [],
      markets: [market()],
      prices: new Map(),
    })
    expect(p).toMatchObject({ valueUsdc: '10', price: null })
  })

  it('removes cost pro rata on a partial sell and books realized P&L', () => {
    const [p] = aggregatePositions({
      trades: [trade(-10n * U, 20n * U, 0n), trade(8n * U, -10n * U, 0n)],
      claims: [],
      markets: [market()],
      prices: new Map([[M, 0.5]]),
    })
    // 10 shares left at cost 5; sold half for 8 against cost 5 -> realized +3; value 5.
    expect(p).toMatchObject({ shares: '10', costUsdc: '5', valueUsdc: '5', pnlUsdc: '3' })
  })

  it('carries cost across a YES->NO swap', () => {
    const out = aggregatePositions({
      trades: [trade(-10n * U, 20n * U, 0n), trade(0n, -20n * U, 15n * U)],
      claims: [],
      markets: [market()],
      prices: new Map([[M, 0.4]]),
    })
    // The emptied YES book has no shares, cost or realized P&L, so it is not listed.
    expect(out.map((p) => [p.side, p.shares, p.costUsdc])).toEqual([['away', '15', '10']])
  })

  it('credits a claim to the winning side and marks the rest unclaimable', () => {
    const resolved = market({ status: 'finalized', outcome: 'yes' })
    const before = aggregatePositions({
      trades: [trade(-10n * U, 20n * U, 0n), trade(-3n * U, 0n, 5n * U)],
      claims: [],
      markets: [resolved],
      prices: new Map(),
    })
    expect(before.map((p) => [p.side, p.valueUsdc, p.claimable])).toEqual([
      ['away', '0', false],
      ['home', '20', true],
    ])
    const after = aggregatePositions({
      trades: [trade(-10n * U, 20n * U, 0n), trade(-3n * U, 0n, 5n * U)],
      claims: [claim('claim', 20n * U, -20n * U, -5n * U)],
      markets: [resolved],
      prices: new Map(),
    })
    expect(after.map((p) => [p.side, p.shares, p.pnlUsdc, p.claimable])).toEqual([
      ['away', '0', '-3', false],
      ['home', '0', '10', false],
    ])
  })

  it('splits a redeem of a YES+NO pair by the amounts sold', () => {
    const out = aggregatePositions({
      trades: [trade(-6n * U, 10n * U, 0n), trade(-4n * U, 0n, 10n * U)],
      claims: [claim('redeem', 10n * U, -10n * U, -10n * U)],
      markets: [market()],
      prices: new Map([[M, 0.5]]),
    })
    expect(out.map((p) => [p.side, p.pnlUsdc])).toEqual([
      ['away', '1'],
      ['home', '-1'],
    ])
  })
})

describe('aggregatePositions ordering and exact values', () => {
  const at = (t: TradeRow, slot: bigint, sig: string, second: number): TradeRow => ({
    ...t,
    slot,
    sig: sig.padEnd(88, 'x'),
    blockTime: new Date(second * 1000),
  })

  it('orders flows of one second by slot, not by signature', () => {
    const [p] = aggregatePositions({
      trades: [
        at(trade(8n * U, -10n * U, 0n), 6n, 'a-sell', 100),
        at(trade(-10n * U, 20n * U, 0n), 5n, 'b-buy', 100),
      ],
      claims: [],
      markets: [market()],
      prices: new Map([[M, 0.5]]),
    })
    // Buy 20 for 10, then sell 10 for 8: 10 left at cost 5, realized +3, value 5.
    expect(p).toMatchObject({ shares: '10', costUsdc: '5', valueUsdc: '5', pnlUsdc: '3' })
  })

  it('still takes the shares off and books the proceeds of a sell ordered before its buy', () => {
    const [p] = aggregatePositions({
      trades: [
        at(trade(8n * U, -10n * U, 0n), 7n, 'a-sell', 100),
        at(trade(-10n * U, 20n * U, 0n), 7n, 'b-buy', 100),
      ],
      claims: [],
      markets: [market()],
      prices: new Map([[M, 0.5]]),
    })
    // Same slot, the sell's signature sorts first: 10 shares, and the same total P&L (+3).
    expect(p).toMatchObject({ shares: '10', costUsdc: '10', valueUsdc: '5', pnlUsdc: '3' })
  })

  it('values shares in exact base units: 100 at 0.29 is worth 29', () => {
    const home = aggregatePositions({
      trades: [trade(-29n * U, 100n * U, 0n)],
      claims: [],
      markets: [market()],
      prices: new Map([[M, 0.29]]),
    })
    expect(home[0]).toMatchObject({ valueUsdc: '29', pnlUsdc: '0' })
    const away = aggregatePositions({
      trades: [trade(-29n * U, 0n, 100n * U)],
      claims: [],
      markets: [market()],
      prices: new Map([[M, 0.71]]),
    })
    expect(away[0]).toMatchObject({ side: 'away', valueUsdc: '29', pnlUsdc: '0' })
  })
})
