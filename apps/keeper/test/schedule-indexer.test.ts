import {
  type DbHandle,
  getMarket,
  listGames,
  listMarketTrades,
  type MarketRow,
  upsertMarket,
  upsertScheduledGames,
} from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import {
  ataAddress,
  buildTradeTransaction,
  DEVNET_MUSDC_MINT,
  HoragonProgram,
  PROTOCOL_DAO,
} from '@horagon/sdk'
import { Keypair, PublicKey, type VersionedTransactionResponse } from '@solana/web3.js'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Ratings } from '../src/elo'
import type { Feed, FeedGame } from '../src/feeds/types'
import { decodeTransaction, type IndexerDeps, indexOnce } from '../src/indexer'
import { pickFeatured, scheduleDates, scheduleTick } from '../src/schedule'

const ratings: Ratings = {
  asOf: '2026-11-17',
  sigma: 13,
  teams: { OKC: 1700, DEN: 1650, BOS: 1640, CLE: 1600, MEM: 1450, WAS: 1400, CHA: 1420, UTA: 1380 },
}

function g(id: string, away: string, home: string, patch: Partial<FeedGame> = {}): FeedGame {
  return {
    league: 'NBA',
    externalId: id,
    gameDate: '2026-11-24',
    home,
    away,
    tipoff: new Date('2026-11-25T00:00:00Z'),
    status: 'scheduled',
    period: 0,
    clockSecs: null,
    homeScore: 0,
    awayScore: 0,
    periods: [],
    cup: false,
    ...patch,
  }
}

const night = [
  g('1', 'MEM', 'WAS'),
  g('2', 'BOS', 'OKC'),
  g('3', 'CHA', 'UTA', { cup: true }),
  g('4', 'CLE', 'DEN'),
  g('5', 'MEM', 'CHA'),
  g('6', 'BOS', 'CLE', { status: 'postponed' }),
]

describe('schedule', () => {
  it('features NBA Cup games first, then the highest Elo sums, at most 4', () => {
    expect(pickFeatured(night, ratings)).toEqual(['nba-3', 'nba-2', 'nba-4', 'nba-5'])
  })

  it('covers the next 36 hours in US Eastern dates', () => {
    // 2026-11-24 05:00 UTC = 00:00 EST.
    expect(scheduleDates(Date.parse('2026-11-24T05:00:00Z') / 1000)).toEqual([
      '2026-11-24',
      '2026-11-25',
    ])
  })

  let h: DbHandle
  beforeEach(async () => {
    h = await createTestDb()
  })
  afterEach(async () => {
    await h.close()
  })

  it('upserts games with p0 and keeps a manual featured choice', async () => {
    const feed: Feed = {
      name: 'fake',
      fetchDay: async (date) => ({
        source: 'fake',
        url: 'https://x.test',
        fetchedAt: new Date(),
        games: date === '2026-11-24' ? night : [],
      }),
    }
    const now = () => Date.parse('2026-11-24T05:00:00Z') / 1000
    const first = await scheduleTick({ db: h.db, feed, ratings, now })
    expect(first).toMatchObject({ upserted: 6, featured: ['nba-3', 'nba-2', 'nba-4', 'nba-5'] })
    const rows = await listGames(h.db, { from: new Date(0), to: new Date('2030-01-01') })
    const okc = rows.find((r) => r.id === 'nba-2')
    expect(okc?.p0).toBeGreaterThan(0.5)
    expect(rows.find((r) => r.id === 'nba-6')?.status).toBe('postponed')
    const again = await scheduleTick({ db: h.db, feed, ratings, now })
    expect(again.featured).toEqual([])
  })
})

describe('indexer decodeTransaction', () => {
  const program = new HoragonProgram({ collateralMint: DEVNET_MUSDC_MINT })
  const sponsor = Keypair.generate().publicKey
  const user = Keypair.generate().publicKey
  const market = Keypair.generate().publicKey
  const yesMint = Keypair.generate().publicKey.toBase58()
  const noMint = Keypair.generate().publicKey.toBase58()
  const row = {
    pubkey: market.toBase58(),
    gameId: 'nba-1',
    yesMint,
    noMint,
    externalLp: false,
  } as MarketRow
  const usdc = DEVNET_MUSDC_MINT.toBase58()
  const bal = (accountIndex: number, owner: string, mint: string, amount: bigint) => ({
    accountIndex,
    owner,
    mint,
    uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null, uiAmountString: '' },
  })

  function swapTx(
    direction: 'usdcToYes' | 'yesToUsdc',
    createAtas: Array<{ owner: PublicKey; mint: PublicKey }> = [],
  ) {
    const tx = buildTradeTransaction({
      feePayer: sponsor,
      recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
      swap: {
        user,
        market,
        collateralMint: DEVNET_MUSDC_MINT,
        authority: program.authority,
        direction,
        amountIn: 20_000_000n,
        minOut: 1n,
      },
      createAtas,
    })
    return tx
  }

  it('records a sponsored buy against the user, not the fee payer, with fees', () => {
    const tx = swapTx('usdcToYes')
    const res = {
      slot: 77,
      blockTime: 1_795_000_000,
      transaction: { message: tx.message, signatures: [] },
      meta: {
        err: null,
        preTokenBalances: [
          bal(1, user.toBase58(), usdc, 100_000_000n),
          bal(2, user.toBase58(), yesMint, 0n),
          bal(3, PROTOCOL_DAO.toBase58(), usdc, 0n),
        ],
        postTokenBalances: [
          bal(1, user.toBase58(), usdc, 80_000_000n),
          bal(2, user.toBase58(), yesMint, 38_721_969n),
          bal(3, PROTOCOL_DAO.toBase58(), usdc, 100_000n),
        ],
      },
    } as unknown as VersionedTransactionResponse
    const d = decodeTransaction('sigA', res, {
      market: row,
      collateralMint: usdc,
      authority: program.authority.toBase58(),
    })
    expect(d.trades).toEqual([
      expect.objectContaining({
        wallet: user.toBase58(),
        direction: 'usdcToYes',
        usdcAmount: 20_000_000n,
        usdcDelta: -20_000_000n,
        yesDelta: 38_721_969n,
        noDelta: 0n,
        fee: 100_000n,
        slot: 77n,
      }),
    ])
    expect(d.claims).toEqual([])
  })

  it('records the token accounts a sponsored trade created for its user', () => {
    const yes = { owner: user, mint: new PublicKey(yesMint) }
    const no = { owner: user, mint: new PublicKey(noMint) }
    const tx = swapTx('usdcToYes', [yes, no])
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58())
    const yesAta = ataAddress(yes).toBase58()
    const noAta = ataAddress(no).toBase58()
    const res = {
      slot: 78,
      blockTime: 1_795_000_100,
      transaction: { message: tx.message, signatures: [] },
      meta: {
        err: null,
        // The NO account existed before this transaction: its rent was paid earlier.
        preTokenBalances: [bal(keys.indexOf(noAta), user.toBase58(), noMint, 0n)],
        postTokenBalances: [
          bal(keys.indexOf(yesAta), user.toBase58(), yesMint, 38_721_969n),
          bal(keys.indexOf(noAta), user.toBase58(), noMint, 0n),
        ],
      },
    } as unknown as VersionedTransactionResponse
    const ctx = {
      market: row,
      collateralMint: usdc,
      authority: program.authority.toBase58(),
    }
    expect(keys.indexOf(yesAta)).toBeGreaterThan(0)
    expect(
      decodeTransaction('sigB', res, { ...ctx, sponsor: sponsor.toBase58() }).sponsoredAtas,
    ).toEqual([{ ata: yesAta, wallet: user.toBase58(), mint: yesMint }])
    // Without the sponsor, or with another fee payer, nothing is recorded.
    expect(decodeTransaction('sigB', res, ctx).sponsoredAtas).toEqual([])
    const other = Keypair.generate().publicKey.toBase58()
    expect(decodeTransaction('sigB', res, { ...ctx, sponsor: other }).sponsoredAtas).toEqual([])
  })

  it('ignores failed transactions and other markets', () => {
    const tx = swapTx('yesToUsdc')
    const failed = {
      slot: 1,
      blockTime: 1,
      transaction: { message: tx.message },
      meta: { err: { InstructionError: [0, 'x'] } },
    }
    const d1 = decodeTransaction('s', failed as unknown as VersionedTransactionResponse, {
      market: row,
      collateralMint: usdc,
      authority: program.authority.toBase58(),
    })
    expect(d1.trades).toEqual([])
    const other = { ...row, pubkey: Keypair.generate().publicKey.toBase58() } as MarketRow
    const ok = {
      slot: 1,
      blockTime: 1,
      transaction: { message: tx.message },
      meta: { err: null, preTokenBalances: [], postTokenBalances: [] },
    }
    const d2 = decodeTransaction('s', ok as unknown as VersionedTransactionResponse, {
      market: other,
      collateralMint: usdc,
      authority: program.authority.toBase58(),
    })
    expect(d2.trades).toEqual([])
  })
})

describe('indexOnce does not skip past a transaction it could not read', () => {
  const program = new HoragonProgram({ collateralMint: DEVNET_MUSDC_MINT })
  const sponsor = Keypair.generate().publicKey
  const user = Keypair.generate().publicKey
  const market = Keypair.generate().publicKey
  const yesMint = Keypair.generate().publicKey.toBase58()
  const noMint = Keypair.generate().publicKey.toBase58()
  const usdc = DEVNET_MUSDC_MINT.toBase58()
  const NOW = Date.parse('2026-11-24T02:00:00Z') / 1000
  const bal = (accountIndex: number, owner: string, mint: string, amount: bigint) => ({
    accountIndex,
    owner,
    mint,
    uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null, uiAmountString: '' },
  })

  const message = buildTradeTransaction({
    feePayer: sponsor,
    recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
    swap: {
      user,
      market,
      collateralMint: DEVNET_MUSDC_MINT,
      authority: program.authority,
      direction: 'usdcToYes',
      amountIn: 20_000_000n,
      minOut: 1n,
    },
    createAtas: [],
  }).message

  const readable = (slot: number, blockTime: number | null) =>
    ({
      slot,
      blockTime,
      transaction: { message, signatures: [] },
      meta: {
        err: null,
        preTokenBalances: [bal(1, user.toBase58(), usdc, 100_000_000n)],
        postTokenBalances: [
          bal(1, user.toBase58(), usdc, 80_000_000n),
          bal(2, user.toBase58(), yesMint, 38_721_969n),
        ],
      },
    }) as unknown as VersionedTransactionResponse

  let h: DbHandle
  /** What the fake chain returns for each signature; absent or null means not readable yet. */
  let chain: Map<string, VersionedTransactionResponse | null>
  /** Signatures of the market, oldest first. */
  const order = ['s1', 's2', 's3']

  const deps = (): IndexerDeps => ({
    db: h.db,
    collateralMint: DEVNET_MUSDC_MINT,
    authority: program.authority,
    alerts: { send: async () => {} },
    log: pino({ level: 'silent' }),
    now: () => NOW,
    connection: {
      getSignaturesForAddress: async (_a: PublicKey, o: { until?: string }) => {
        const newestFirst = [...order].reverse()
        const stop = o.until ? newestFirst.indexOf(o.until) : -1
        return (stop < 0 ? newestFirst : newestFirst.slice(0, stop)).map((signature) => ({
          signature,
          err: null,
        }))
      },
      getTransactions: async (sigs: string[]) => sigs.map((x) => chain.get(x) ?? null),
      getMultipleAccountsInfo: async () => [],
    } as unknown as IndexerDeps['connection'],
  })
  const sigsIndexed = async () =>
    (await listMarketTrades(h.db, [market.toBase58()])).map((t) => t.sig).sort()
  const cursor = async () => (await getMarket(h.db, market.toBase58()))?.indexCursor

  beforeEach(async () => {
    h = await createTestDb()
    await upsertScheduledGames(h.db, [
      {
        id: 'nba-1',
        league: 'NBA',
        externalId: '1',
        gameDate: '2026-11-24',
        home: 'WAS',
        away: 'MEM',
        scheduledTipoff: new Date('2026-11-25T00:00:00Z'),
        status: 'scheduled',
        p0: 0.5,
      },
    ])
    await upsertMarket(h.db, {
      pubkey: market.toBase58(),
      gameId: 'nba-1',
      kind: 0,
      marketId: '1',
      gameMarketPda: Keypair.generate().publicKey.toBase58(),
      yesMint,
      noMint,
      initialPriceBps: 5000,
      endTs: new Date((NOW - 3600) * 1000),
      seedAmount: 1_000_000n,
      status: 'halted',
    })
  })
  afterEach(async () => {
    await h.close()
  })

  it('stops at an unreadable transaction and picks it up, and everything after it, next tick', async () => {
    chain = new Map([
      ['s1', readable(1, 1_795_000_001)],
      ['s2', null],
      ['s3', readable(3, 1_795_000_003)],
    ])
    expect(await indexOnce(deps())).toMatchObject({ trades: 1 })
    expect(await sigsIndexed()).toEqual(['s1'])
    expect(await cursor()).toBe('s1')

    chain.set('s2', readable(2, 1_795_000_002))
    expect(await indexOnce(deps())).toMatchObject({ trades: 2 })
    expect(await sigsIndexed()).toEqual(['s1', 's2', 's3'])
    expect(await cursor()).toBe('s3')
    const times = (await listMarketTrades(h.db, [market.toBase58()])).map((t) =>
      Math.floor(t.blockTime.getTime() / 1000),
    )
    expect(Math.min(...times)).toBe(1_795_000_001)
  })

  it('treats a transaction with no block time the same way, never writing epoch 0', async () => {
    chain = new Map([
      ['s1', readable(1, 1_795_000_001)],
      ['s2', readable(2, null)],
      ['s3', readable(3, 1_795_000_003)],
    ])
    await indexOnce(deps())
    expect(await sigsIndexed()).toEqual(['s1'])
    expect(await cursor()).toBe('s1')

    chain.set('s2', readable(2, 1_795_000_002))
    await indexOnce(deps())
    expect(await sigsIndexed()).toEqual(['s1', 's2', 's3'])
    expect(await cursor()).toBe('s3')
    const rows = await listMarketTrades(h.db, [market.toBase58()])
    expect(rows.every((t) => t.blockTime.getTime() > 0)).toBe(true)
  })

  it('leaves the cursor alone when the first transaction is unreadable', async () => {
    chain = new Map([
      ['s1', null],
      ['s2', readable(2, 1_795_000_002)],
      ['s3', readable(3, 1_795_000_003)],
    ])
    expect(await indexOnce(deps())).toMatchObject({ trades: 0 })
    expect(await sigsIndexed()).toEqual([])
    expect(await cursor()).toBeNull()
  })
})
