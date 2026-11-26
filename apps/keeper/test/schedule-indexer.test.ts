import {
  type DbHandle,
  getMarket,
  listGames,
  listMarketTrades,
  listPricePoints,
  type MarketRow,
  sponsoredAtasToCheck,
  updateMarket,
  upsertMarket,
  upsertScheduledGames,
} from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import {
  ataAddress,
  buildClaimWinningsIx,
  buildRedeemPairIx,
  buildSwapIx,
  buildTradeTransaction,
  DEVNET_MUSDC_MINT,
  deriveNoMint,
  deriveVault,
  deriveYesMint,
  HoragonProgram,
  PM_AMM_IX_DISCRIMINATORS,
  PM_AMM_PROGRAM_ID,
  PROTOCOL_DAO,
} from '@horagon/sdk'
import {
  createAssociatedTokenAccountInstruction,
  createBurnCheckedInstruction,
  createBurnInstruction,
  createCloseAccountInstruction,
  createMintToCheckedInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  createTransferInstruction,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  type VersionedTransactionResponse,
} from '@solana/web3.js'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ratings } from '../src/elo'
import type { Feed, FeedGame } from '../src/feeds/types'
import {
  decodeTransaction,
  type IndexerDeps,
  indexOnce,
  inRequestOrder,
  STUCK_AFTER,
  wholeTxFlows,
} from '../src/indexer'
import { pickFeatured, scheduleDates, scheduleTick } from '../src/schedule'

// Market accounts are not decoded for real here: the first data byte says what the account holds
// (1 = a price of 0.4, 2 = no price yet, 3 = undecodable).
vi.mock('@horagon/sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@horagon/sdk')>()
  return {
    ...real,
    decodeMarketAccount: (info: { data: Uint8Array }) => {
      if (info.data[0] === 3) throw new Error('bad account')
      return { price: info.data[0] === 1 ? 0.4 : null } as never
    },
    liveMarket: (m: { price: number | null }) => ({ price: m.price, liquidity: 0, closed: false }),
  }
})

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

  it('stores a game the schedule pass sees live or final as scheduled', async () => {
    const feed: Feed = {
      name: 'fake',
      fetchDay: async (date) => ({
        source: 'fake',
        url: 'https://x.test',
        fetchedAt: new Date(),
        games:
          date === '2026-11-24'
            ? [g('7', 'MEM', 'WAS', { status: 'live' }), g('8', 'BOS', 'OKC', { status: 'final' })]
            : [],
      }),
    }
    const now = () => Date.parse('2026-11-24T05:00:00Z') / 1000
    await scheduleTick({ db: h.db, feed, ratings, now })
    const rows = await listGames(h.db, { from: new Date(0), to: new Date('2030-01-01') })
    expect(rows.find((r) => r.id === 'nba-7')?.status).toBe('scheduled')
    expect(rows.find((r) => r.id === 'nba-8')?.status).toBe('scheduled')
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

describe('inRequestOrder', () => {
  const tx = (id?: string) => ({ transaction: { signatures: id === undefined ? [] : [id] } })

  it('puts each answer at the signature it carries, whatever order it came in', () => {
    const [a, b, c] = [tx('a'), tx('b'), tx('c')]
    expect(inRequestOrder(['a', 'b', 'c'], [c, a, b])).toEqual([a, b, c])
  })

  it('reads a null, a short answer, a foreign answer and an empty signature list as missing', () => {
    const b = tx('b')
    expect(inRequestOrder(['a', 'b', 'c'], [null, b])).toEqual([null, b, null])
    expect(inRequestOrder(['a'], [tx('x')])).toEqual([null])
    expect(inRequestOrder(['a'], [tx()])).toEqual([null])
    expect(inRequestOrder(['a', 'b'], [])).toEqual([null, null])
  })

  it('keeps the first of two answers for one signature', () => {
    const first = tx('a')
    const second = tx('a')
    expect(inRequestOrder(['a'], [first, second])[0]).toBe(first)
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

  const readable = (sig: string, slot: number, blockTime: number | null) =>
    ({
      slot,
      blockTime,
      transaction: { message, signatures: [sig] },
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
  let order: string[]
  let failed: Set<string>
  let shortBatch: boolean
  /** Answer each batch in reverse, as devnet may (JSON-RPC lets a node answer in any order). */
  let reversedBatch: boolean
  /** The whole batch call throws when it asks for one of these (web3.js on an error entry). */
  let throwOn: Set<string>
  let signatureCalls: number
  let requested: string[]
  let sent: string[]
  let warns: Array<{ obj: Record<string, unknown>; msg: string }>
  let stops: NonNullable<IndexerDeps['stops']>
  let accountFor: (key: string) => { owner: PublicKey; data: Uint8Array } | null

  const deps = (): IndexerDeps => ({
    db: h.db,
    collateralMint: DEVNET_MUSDC_MINT,
    authority: program.authority,
    alerts: {
      send: async (key) => {
        sent.push(key)
      },
    },
    log: {
      warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }),
    } as unknown as Logger,
    now: () => NOW,
    stops,
    connection: {
      getSignaturesForAddress: async (
        _a: PublicKey,
        o: { until?: string; before?: string; limit?: number },
      ) => {
        signatureCalls++
        let list = [...order].reverse()
        if (o.before) list = list.slice(list.indexOf(o.before) + 1)
        if (o.until) {
          const k = list.indexOf(o.until)
          if (k >= 0) list = list.slice(0, k)
        }
        return list
          .slice(0, o.limit ?? 1000)
          .map((signature) => ({ signature, err: failed.has(signature) ? { err: 1 } : null }))
      },
      getTransactions: async (sigs: string[]) => {
        requested.push(...sigs)
        if (sigs.some((x) => throwOn.has(x))) throw new Error('429 Too Many Requests')
        const txs = sigs.map((x) => chain.get(x) ?? null)
        if (shortBatch) return txs.slice(0, 1)
        return reversedBatch ? txs.reverse() : txs
      },
      getMultipleAccountsInfo: async (keys: PublicKey[]) =>
        keys.map((k) => accountFor(k.toBase58())),
    } as unknown as IndexerDeps['connection'],
  })
  /** A readable transaction that touches some other market: it decodes to no rows. */
  const readableElsewhere = (sig: string, slot: number) =>
    ({
      slot,
      blockTime: 1_795_000_000 + slot,
      transaction: {
        message: buildTradeTransaction({
          feePayer: sponsor,
          recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
          swap: {
            user,
            market: Keypair.generate().publicKey,
            collateralMint: DEVNET_MUSDC_MINT,
            authority: program.authority,
            direction: 'usdcToYes',
            amountIn: 1n,
            minOut: 1n,
          },
          createAtas: [],
        }).message,
        signatures: [sig],
      },
      meta: { err: null, preTokenBalances: [], postTokenBalances: [] },
    }) as unknown as VersionedTransactionResponse
  const depositTx = (sig: string, who: PublicKey) =>
    ({
      slot: 1,
      blockTime: 1_795_000_001,
      transaction: {
        message: new TransactionMessage({
          payerKey: who,
          recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
          instructions: [
            new TransactionInstruction({
              programId: PM_AMM_PROGRAM_ID,
              keys: [
                { pubkey: who, isSigner: true, isWritable: true },
                { pubkey: market, isSigner: false, isWritable: true },
              ],
              data: Buffer.from([
                ...PM_AMM_IX_DISCRIMINATORS.depositLiquidity,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
                0,
              ]),
            }),
          ],
        }).compileToV0Message(),
        signatures: [sig],
      },
      meta: { err: null, preTokenBalances: [], postTokenBalances: [] },
    }) as unknown as VersionedTransactionResponse
  const sigsIndexed = async () =>
    (await listMarketTrades(h.db, [market.toBase58()])).map((t) => t.sig).sort()
  const cursor = async () => (await getMarket(h.db, market.toBase58()))?.indexCursor

  beforeEach(async () => {
    h = await createTestDb()
    order = ['s1', 's2', 's3']
    failed = new Set()
    shortBatch = false
    reversedBatch = false
    throwOn = new Set()
    signatureCalls = 0
    requested = []
    sent = []
    warns = []
    stops = new Map()
    accountFor = () => null
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
      ['s1', readable('s1', 1, 1_795_000_001)],
      ['s2', null],
      ['s3', readable('s3', 3, 1_795_000_003)],
    ])
    expect(await indexOnce(deps())).toMatchObject({ trades: 1 })
    expect(await sigsIndexed()).toEqual(['s1'])
    expect(await cursor()).toBe('s1')

    chain.set('s2', readable('s2', 2, 1_795_000_002))
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
      ['s1', readable('s1', 1, 1_795_000_001)],
      ['s2', readable('s2', 2, null)],
      ['s3', readable('s3', 3, 1_795_000_003)],
    ])
    await indexOnce(deps())
    expect(await sigsIndexed()).toEqual(['s1'])
    expect(await cursor()).toBe('s1')

    chain.set('s2', readable('s2', 2, 1_795_000_002))
    await indexOnce(deps())
    expect(await sigsIndexed()).toEqual(['s1', 's2', 's3'])
    expect(await cursor()).toBe('s3')
    const rows = await listMarketTrades(h.db, [market.toBase58()])
    expect(rows.every((t) => t.blockTime.getTime() > 0)).toBe(true)
  })

  it('leaves the cursor alone when the first transaction is unreadable', async () => {
    chain = new Map([
      ['s1', null],
      ['s2', readable('s2', 2, 1_795_000_002)],
      ['s3', readable('s3', 3, 1_795_000_003)],
    ])
    expect(await indexOnce(deps())).toMatchObject({ trades: 0 })
    expect(await sigsIndexed()).toEqual([])
    expect(await cursor()).toBeNull()
  })

  it('sends an index-stuck alert on every stop from the 60th on the same signature, and resets on recovery', async () => {
    chain = new Map([['s1', null]])
    order = ['s1']
    for (let i = 0; i < 59; i++) await indexOnce(deps())
    expect(sent).toEqual([])
    await indexOnce(deps())
    await indexOnce(deps())
    // Sent on every stop from the 60th on; the alerter's dedupe throttles the repeats.
    expect(sent).toEqual(Array(2).fill(`index-stuck:${market.toBase58()}`))
    // Logged at warn, but only once a minute for the market (the fake clock does not move).
    expect(warns.filter((w) => w.msg.includes('not readable'))).toHaveLength(1)
    expect(warns[0]?.obj).toMatchObject({ market: market.toBase58(), sig: 's1' })

    // The market moves past s1; a new stuck signature starts counting from zero.
    chain.set('s1', readable('s1', 1, 1_795_000_001))
    order = ['s1', 's2']
    chain.set('s2', null)
    for (let i = 0; i < 59; i++) await indexOnce(deps())
    expect(sent).toHaveLength(2)
    await indexOnce(deps())
    expect(sent).toHaveLength(3)

    chain.set('s2', readable('s2', 2, 1_795_000_002))
    await indexOnce(deps())
    expect(stops.has(market.toBase58())).toBe(false)
  }, 120_000)

  it('still delivers the stall alert on a later stop when the first send is lost', async () => {
    chain = new Map([['s1', null]])
    order = ['s1']
    // Like the real alerter: a failed delivery is swallowed and the key is open again.
    let attempts = 0
    const delivered: string[] = []
    const lossy = (): IndexerDeps => ({
      ...deps(),
      alerts: {
        send: async (key) => {
          attempts++
          if (attempts > 1) delivered.push(key)
        },
      },
    })
    for (let i = 0; i < STUCK_AFTER + 1; i++) await indexOnce(lossy())
    expect(attempts).toBe(2)
    expect(delivered).toEqual([`index-stuck:${market.toBase58()}`])
  }, 120_000)

  it('rate-limits the stall warning per market, not per signature', async () => {
    let t = NOW
    const timed = (): IndexerDeps => ({ ...deps(), now: () => t })
    const stalls = () => warns.filter((w) => w.msg.includes('not readable'))
    chain = new Map([['s1', null]])
    order = ['s1']
    await indexOnce(timed())
    expect(stalls()).toHaveLength(1)

    // The market moves on to a new stuck signature 5 s later: still the same minute.
    t += 5
    chain.set('s1', readable('s1', 1, 1_795_000_001))
    chain.set('s2', null)
    order = ['s1', 's2']
    await indexOnce(timed())
    expect(stops.get(market.toBase58())).toMatchObject({ sig: 's2', count: 1 })
    expect(stalls()).toHaveLength(1)

    t += 60
    await indexOnce(timed())
    expect(stalls()).toHaveLength(2)
  })

  it('keeps the stall counter when a pass fetches no signatures', async () => {
    chain = new Map([['s1', null]])
    order = ['s1']
    for (let i = 0; i < 3; i++) await indexOnce(deps())
    expect(stops.get(market.toBase58())?.count).toBe(3)
    order = []
    await indexOnce(deps())
    expect(stops.get(market.toBase58())?.count).toBe(3)
    order = ['s1']
    await indexOnce(deps())
    expect(stops.get(market.toBase58())?.count).toBe(4)
  })

  it('alerts index-skip with the signature and instruction when a row is skipped for good', async () => {
    const swapIx = () =>
      buildSwapIx({
        user,
        market,
        collateralMint: DEVNET_MUSDC_MINT,
        authority: program.authority,
        direction: 'usdcToYes',
        amountIn: 1n,
        minOut: 1n,
      })
    const two = {
      slot: 1,
      blockTime: 1_795_000_001,
      transaction: {
        message: new TransactionMessage({
          payerKey: user,
          recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
          instructions: [swapIx(), swapIx()],
        }).compileToV0Message(),
        signatures: ['s1'],
      },
      meta: { err: null, preTokenBalances: [], postTokenBalances: [] },
    } as unknown as VersionedTransactionResponse
    chain = new Map([['s1', two]])
    order = ['s1']
    const texts: Array<[string, string]> = []
    await indexOnce({
      ...deps(),
      alerts: { send: async (key, text) => void texts.push([key, text]) },
    })
    expect(await sigsIndexed()).toEqual([])
    const skip = texts.filter(([k]) => k === `index-skip:${market.toBase58()}`)
    expect(skip.length).toBeGreaterThan(0)
    expect(skip[0]?.[1]).toContain('s1')
    expect(skip[0]?.[1]).toContain('instruction 0')
  })

  it('reads a batch answered out of order whole, in signature order', async () => {
    chain = new Map([
      ['s1', readable('s1', 1, 1_795_000_001)],
      ['s2', readable('s2', 2, 1_795_000_002)],
      ['s3', readable('s3', 3, 1_795_000_003)],
    ])
    reversedBatch = true
    await indexOnce(deps())
    expect(requested).toEqual(['s1', 's2', 's3'])
    // Each row carries its own transaction's slot and block time, not a neighbour's.
    const rows = await listMarketTrades(h.db, [market.toBase58()])
    expect(rows.map((t) => [t.sig, Number(t.slot), t.blockTime.getTime() / 1000]).sort()).toEqual([
      ['s1', 1, 1_795_000_001],
      ['s2', 2, 1_795_000_002],
      ['s3', 3, 1_795_000_003],
    ])
    expect(await cursor()).toBe('s3')
  })

  it('pairs an out-of-order answer that holds a null by signature, as devnet sends it', async () => {
    chain = new Map([
      ['s1', null],
      ['s2', readable('s2', 2, 1_795_000_002)],
      ['s3', readable('s3', 3, 1_795_000_003)],
    ])
    reversedBatch = true
    // Answer [s3, s2, null]: the null is s1's, so nothing is read past it.
    await indexOnce(deps())
    expect(await sigsIndexed()).toEqual([])
    expect(await cursor()).toBeNull()

    chain.set('s1', readable('s1', 1, 1_795_000_001))
    chain.set('s2', null)
    // Answer [s3, null, s1]: s1 is read, the scan stops at s2.
    await indexOnce(deps())
    expect(await sigsIndexed()).toEqual(['s1'])
    expect(await cursor()).toBe('s1')

    chain.set('s2', readable('s2', 2, 1_795_000_002))
    await indexOnce(deps())
    expect(await sigsIndexed()).toEqual(['s1', 's2', 's3'])
    expect(await cursor()).toBe('s3')
  })

  it('keeps the chunks it read when a later batch call fails, and counts the stop', async () => {
    order = Array.from({ length: 60 }, (_, i) => `b${String(i).padStart(2, '0')}`)
    chain = new Map(order.map((sig, i) => [sig, readable(sig, i + 1, 1_795_000_001 + i)]))
    throwOn = new Set(['b55'])
    await indexOnce(deps())
    expect(await sigsIndexed()).toEqual(order.slice(0, 50))
    expect(await cursor()).toBe('b49')
    expect(stops.get(market.toBase58())).toMatchObject({ sig: 'b50', count: 1 })
    expect(warns.find((w) => w.msg === 'transaction batch read failed')?.obj).toMatchObject({
      market: market.toBase58(),
      error: expect.stringContaining('429'),
    })
    expect(warns.some((w) => w.msg === 'index failed')).toBe(false)

    throwOn = new Set()
    await indexOnce(deps())
    expect(await sigsIndexed()).toEqual(order)
    expect(await cursor()).toBe('b59')
    expect(stops.has(market.toBase58())).toBe(false)
  })

  it('stops at the first signature a short batch, a missing meta, or a foreign answer leaves unread', async () => {
    chain = new Map([
      ['s1', readable('s1', 1, 1_795_000_001)],
      ['s2', readable('s2', 2, 1_795_000_002)],
      ['s3', readable('s3', 3, 1_795_000_003)],
    ])
    shortBatch = true
    await indexOnce(deps())
    expect(await sigsIndexed()).toEqual(['s1'])
    expect(await cursor()).toBe('s1')
    shortBatch = false
    await indexOnce(deps())
    expect(await cursor()).toBe('s3')
    await updateMarket(h.db, market.toBase58(), { indexCursor: null })

    const noMeta = { ...(chain.get('s2') as object), meta: null }
    chain.set('s2', noMeta as unknown as VersionedTransactionResponse)
    await indexOnce(deps())
    expect(await cursor()).toBe('s1')

    chain.set('s2', readable('someone-else', 2, 1_795_000_002))
    await indexOnce(deps())
    expect(await cursor()).toBe('s1')

    chain.set('s2', readable('s2', 2, 1_795_000_002))
    await indexOnce(deps())
    expect(await sigsIndexed()).toEqual(['s1', 's2', 's3'])
    expect(await cursor()).toBe('s3')
  })

  it('moves the cursor past failed signatures when nothing stopped the scan', async () => {
    chain = new Map()
    failed = new Set(['s1', 's2', 's3'])
    expect(await indexOnce(deps())).toMatchObject({ trades: 0 })
    expect(await cursor()).toBe('s3')
    // A failed newest signature after good ones: the good ones are indexed, the cursor is the newest.
    await updateMarket(h.db, market.toBase58(), { indexCursor: null })
    failed = new Set(['s3'])
    chain = new Map([
      ['s1', readable('s1', 1, 1_795_000_001)],
      ['s2', readable('s2', 2, 1_795_000_002)],
    ])
    await indexOnce(deps())
    expect(await sigsIndexed()).toEqual(['s1', 's2'])
    expect(await cursor()).toBe('s3')
  })

  it('pages back past 1,000 signatures and drops the failed ones', async () => {
    order = Array.from({ length: 1_001 }, (_, i) => `p${String(i).padStart(4, '0')}`)
    chain = new Map(order.map((sig, i) => [sig, readableElsewhere(sig, i + 1)]))
    failed = new Set(['p0500'])
    expect(await indexOnce(deps())).toMatchObject({ trades: 0 })
    expect(signatureCalls).toBe(2)
    expect(requested).not.toContain('p0500')
    expect(requested).toHaveLength(1_000)
    expect(await cursor()).toBe('p1000')
  }, 60_000)

  it('flags external liquidity once and alerts once', async () => {
    chain = new Map([['s1', depositTx('s1', user)]])
    order = ['s1']
    await indexOnce(deps())
    expect((await getMarket(h.db, market.toBase58()))?.externalLp).toBe(true)
    chain.set('s2', depositTx('s2', user))
    order = ['s1', 's2']
    await indexOnce(deps())
    expect(sent).toEqual([`external-lp:${market.toBase58()}`])
  })

  it('records the accounts a sponsored trade created, with the transaction time', async () => {
    const yes = { owner: user, mint: new PublicKey(yesMint) }
    const built = buildTradeTransaction({
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
      createAtas: [yes],
    })
    const keys = built.message.staticAccountKeys.map((k) => k.toBase58())
    const ata = ataAddress(yes).toBase58()
    chain = new Map([
      [
        's1',
        {
          slot: 1,
          blockTime: 1_795_000_001,
          transaction: { message: built.message, signatures: ['s1'] },
          meta: {
            err: null,
            preTokenBalances: [bal(1, user.toBase58(), usdc, 100_000_000n)],
            postTokenBalances: [
              bal(1, user.toBase58(), usdc, 80_000_000n),
              bal(keys.indexOf(ata), user.toBase58(), yesMint, 1n),
            ],
          },
        } as unknown as VersionedTransactionResponse,
      ],
    ])
    order = ['s1']
    await indexOnce({ ...deps(), sponsor })
    const rows = await sponsoredAtasToCheck(h.db)
    expect(rows).toEqual([
      expect.objectContaining({
        ata,
        wallet: user.toBase58(),
        createdSig: 's1',
        createdAt: new Date(1_795_000_001_000),
      }),
    ])
  })

  it('writes a price point per open market, skipping a null price, a missing account and a bad one', async () => {
    order = []
    chain = new Map()
    const open = [1, null, 3, 2, 1].map((tag, i) => ({
      tag,
      key: Keypair.generate().publicKey,
      i,
    }))
    for (const o of open) {
      await upsertMarket(h.db, {
        pubkey: o.key.toBase58(),
        gameId: 'nba-1',
        kind: 0,
        marketId: `open-${o.i}`,
        gameMarketPda: Keypair.generate().publicKey.toBase58(),
        yesMint: Keypair.generate().publicKey.toBase58(),
        noMint: Keypair.generate().publicKey.toBase58(),
        initialPriceBps: 5000,
        endTs: new Date((NOW + 3600 + o.i) * 1000),
        seedAmount: 1_000_000n,
        status: 'open',
      })
    }
    accountFor = (key) => {
      const o = open.find((x) => x.key.toBase58() === key)
      return o?.tag === null || !o ? null : { owner: program.authority, data: Uint8Array.of(o.tag) }
    }
    expect(await indexOnce(deps())).toMatchObject({ prices: 2 })
    expect(warns.filter((w) => w.msg === 'price point failed')).toHaveLength(1)
    const points = await listPricePoints(
      h.db,
      open.map((o) => o.key.toBase58()),
    )
    expect(points).toHaveLength(2)

    // One failing read must not stop the pass.
    accountFor = () => {
      throw new Error('rpc down')
    }
    expect(await indexOnce(deps())).toMatchObject({ prices: 0 })
    expect(warns.filter((w) => w.msg === 'price read failed')).toHaveLength(1)
  })
})

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function b58(bytes: Uint8Array): string {
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = `1${out}`
  }
  return out
}

describe('decodeTransaction per-instruction token flows', () => {
  const program = new HoragonProgram({ collateralMint: DEVNET_MUSDC_MINT })
  const user = Keypair.generate().publicKey
  const usdc = DEVNET_MUSDC_MINT.toBase58()
  const usdcAta = ataAddress({ owner: user, mint: DEVNET_MUSDC_MINT })
  const mk = (market: PublicKey) => ({
    market,
    yes: deriveYesMint(market),
    no: deriveNoMint(market),
    vault: deriveVault(market),
    row: {
      pubkey: market.toBase58(),
      gameId: 'nba-1',
      yesMint: deriveYesMint(market).toBase58(),
      noMint: deriveNoMint(market).toBase58(),
      externalLp: false,
    } as MarketRow,
  })
  const A = mk(Keypair.generate().publicKey)
  const B = mk(Keypair.generate().publicKey)
  const ctx = (m: ReturnType<typeof mk>, log?: Logger) => ({
    market: m.row,
    collateralMint: usdc,
    authority: program.authority.toBase58(),
    ...(log ? { log } : {}),
  })
  const bal = (accountIndex: number, owner: string, mint: string, amount: bigint) => ({
    accountIndex,
    owner,
    mint,
    uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null, uiAmountString: '' },
  })
  const yesAta = (m: ReturnType<typeof mk>) => ataAddress({ owner: user, mint: m.yes })
  const noAta = (m: ReturnType<typeof mk>) => ataAddress({ owner: user, mint: m.no })

  /** A transaction of `ixs` with the SPL Token CPIs `inner[i]` recorded under outer instruction i. */
  function build(
    ixs: TransactionInstruction[],
    inner: Array<{ index: number; ixs: TransactionInstruction[] }> | undefined,
    accounts: Array<[PublicKey, string, string]>,
    payer: PublicKey = user,
    /** Token balances before and after, by account; absent accounts hold 0 both times. */
    amounts: Map<string, [bigint, bigint]> = new Map(),
  ) {
    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
      instructions: ixs,
    }).compileToV0Message()
    const keys = message.staticAccountKeys.map((k) => k.toBase58())
    const idx = (k: PublicKey) => keys.indexOf(k.toBase58())
    const at = (n: 0 | 1) =>
      accounts
        .filter(([a], i) => accounts.findIndex(([b]) => b.equals(a)) === i)
        .map(([a, owner, mint]) => bal(idx(a), owner, mint, amounts.get(a.toBase58())?.[n] ?? 0n))
    return {
      slot: 9,
      blockTime: 1_795_000_000,
      transaction: { message, signatures: [] },
      meta: {
        err: null,
        preTokenBalances: at(0),
        postTokenBalances: at(1),
        ...(inner
          ? {
              innerInstructions: inner.map((i) => ({
                index: i.index,
                instructions: i.ixs.map((ix) => ({
                  programIdIndex: idx(ix.programId),
                  accounts: ix.keys.map((k) => idx(k.pubkey)),
                  data: b58(ix.data),
                })),
              })),
            }
          : {}),
      },
    } as unknown as VersionedTransactionResponse
  }
  const accountsOf = (m: ReturnType<typeof mk>): Array<[PublicKey, string, string]> => [
    [usdcAta, user.toBase58(), usdc],
    [yesAta(m), user.toBase58(), m.yes.toBase58()],
    [noAta(m), user.toBase58(), m.no.toBase58()],
    [m.vault, m.market.toBase58(), usdc],
  ]
  const claimIx = (m: ReturnType<typeof mk>) =>
    buildClaimWinningsIx({ user, market: m.market, collateralMint: DEVNET_MUSDC_MINT })

  it('gives each market of a two-market claim its own payout', () => {
    const tx = build(
      [claimIx(A), claimIx(B)],
      [
        {
          index: 0,
          ixs: [
            createTransferInstruction(A.vault, usdcAta, user, 5_000_000n),
            createBurnInstruction(yesAta(A), A.yes, user, 5_000_000n),
          ],
        },
        {
          index: 1,
          ixs: [
            createTransferInstruction(B.vault, usdcAta, user, 7_000_000n),
            createBurnInstruction(noAta(B), B.no, user, 7_000_000n),
          ],
        },
      ],
      [...accountsOf(A), ...accountsOf(B)],
      user,
      new Map<string, [bigint, bigint]>([
        [usdcAta.toBase58(), [1_000_000n, 13_000_000n]],
        [yesAta(A).toBase58(), [5_000_000n, 0n]],
        [noAta(B).toBase58(), [7_000_000n, 0n]],
        [A.vault.toBase58(), [5_000_000n, 0n]],
        [B.vault.toBase58(), [7_000_000n, 0n]],
      ]),
    )
    const a = decodeTransaction('claim', tx, ctx(A))
    const b = decodeTransaction('claim', tx, ctx(B))
    // The per-instruction payouts add up to what the whole transaction paid the user.
    const whole = wholeTxFlows(tx, user.toBase58(), ctx(A))
    expect(whole.usdc).toBe(12_000_000n)
    expect((a.claims[0]?.usdcAmount ?? 0n) + (b.claims[0]?.usdcAmount ?? 0n)).toBe(whole.usdc)
    expect(a.claims[0]?.yesDelta).toBe(whole.yes)
    expect(b.claims[0]?.noDelta).toBe(wholeTxFlows(tx, user.toBase58(), ctx(B)).no)
    expect(a.claims).toEqual([
      expect.objectContaining({
        kind: 'claim',
        ixIndex: 0,
        usdcAmount: 5_000_000n,
        yesDelta: -5_000_000n,
        noDelta: 0n,
      }),
    ])
    expect(b.claims).toEqual([
      expect.objectContaining({
        kind: 'claim',
        ixIndex: 1,
        usdcAmount: 7_000_000n,
        yesDelta: 0n,
        noDelta: -7_000_000n,
      }),
    ])
  })

  it('gives two swaps on one market two rows that sum to the transaction delta', () => {
    const swap = (direction: 'usdcToYes' | 'yesToUsdc', amountIn: bigint) =>
      buildSwapIx({
        user,
        market: A.market,
        collateralMint: DEVNET_MUSDC_MINT,
        authority: program.authority,
        direction,
        amountIn,
        minOut: 1n,
      })
    const daoAta = ataAddress({ owner: PROTOCOL_DAO, mint: DEVNET_MUSDC_MINT })
    const tx = build(
      [swap('usdcToYes', 20_000_000n), swap('yesToUsdc', 10_000_000n)],
      [
        {
          index: 0,
          ixs: [
            createTransferInstruction(usdcAta, A.vault, user, 19_900_000n),
            createTransferInstruction(usdcAta, daoAta, user, 100_000n),
            createMintToInstruction(A.yes, yesAta(A), user, 38_000_000n),
            // Not a transfer, mint or burn: ignored, as is a program that is not SPL Token.
            createCloseAccountInstruction(noAta(A), user, user),
            new TransactionInstruction({
              programId: PM_AMM_PROGRAM_ID,
              keys: [],
              data: Buffer.alloc(9),
            }),
          ],
        },
        {
          index: 1,
          ixs: [
            createBurnInstruction(yesAta(A), A.yes, user, 10_000_000n),
            createTransferInstruction(A.vault, usdcAta, user, 5_000_000n),
          ],
        },
      ],
      [...accountsOf(A), [daoAta, PROTOCOL_DAO.toBase58(), usdc]],
      user,
      new Map<string, [bigint, bigint]>([
        [usdcAta.toBase58(), [100_000_000n, 85_000_000n]],
        [yesAta(A).toBase58(), [0n, 28_000_000n]],
        [A.vault.toBase58(), [50_000_000n, 64_900_000n]],
        [daoAta.toBase58(), [0n, 100_000n]],
      ]),
    )
    const d = decodeTransaction('two', tx, ctx(A))
    expect(d.trades.map((t) => [t.ixIndex, t.direction, t.usdcDelta, t.yesDelta, t.fee])).toEqual([
      [0, 'usdcToYes', -20_000_000n, 38_000_000n, 100_000n],
      [1, 'yesToUsdc', 5_000_000n, -10_000_000n, 0n],
    ])
    const whole = wholeTxFlows(tx, user.toBase58(), ctx(A))
    expect(whole).toEqual({ usdc: -15_000_000n, yes: 28_000_000n, no: 0n, fee: 100_000n })
    const sum = (pick: (t: (typeof d.trades)[number]) => bigint) =>
      d.trades.reduce((n, t) => n + pick(t), 0n)
    expect(sum((t) => t.usdcDelta)).toBe(whole.usdc)
    expect(sum((t) => t.yesDelta)).toBe(whole.yes)
    expect(sum((t) => t.noDelta)).toBe(whole.no)
    expect(sum((t) => t.fee)).toBe(whole.fee)
  })

  it('reads TransferChecked, BurnChecked and MintToChecked under Token-2022', () => {
    const swap = (direction: 'usdcToYes' | 'yesToUsdc', amountIn: bigint) =>
      buildSwapIx({
        user,
        market: A.market,
        collateralMint: DEVNET_MUSDC_MINT,
        authority: program.authority,
        direction,
        amountIn,
        minOut: 1n,
      })
    const daoAta = ataAddress({ owner: PROTOCOL_DAO, mint: DEVNET_MUSDC_MINT })
    const t22 = TOKEN_2022_PROGRAM_ID
    // Last, so it only puts the Token-2022 program among the static keys.
    const keyHolder = new TransactionInstruction({
      programId: t22,
      keys: [],
      data: Buffer.alloc(0),
    })
    const checked = (from: PublicKey, to: PublicKey, amount: bigint) =>
      createTransferCheckedInstruction(from, DEVNET_MUSDC_MINT, to, user, amount, 6, [], t22)
    const tx = build(
      [swap('usdcToYes', 20_000_000n), swap('yesToUsdc', 10_000_000n), keyHolder],
      [
        {
          index: 0,
          ixs: [
            checked(usdcAta, A.vault, 19_900_000n),
            checked(usdcAta, daoAta, 100_000n),
            createMintToCheckedInstruction(A.yes, yesAta(A), user, 38_000_000n, 6, [], t22),
          ],
        },
        {
          index: 1,
          ixs: [
            createBurnCheckedInstruction(yesAta(A), A.yes, user, 10_000_000n, 6, [], t22),
            checked(A.vault, usdcAta, 5_000_000n),
          ],
        },
      ],
      [...accountsOf(A), [daoAta, PROTOCOL_DAO.toBase58(), usdc]],
      user,
      new Map<string, [bigint, bigint]>([
        [usdcAta.toBase58(), [100_000_000n, 85_000_000n]],
        [yesAta(A).toBase58(), [0n, 28_000_000n]],
        [A.vault.toBase58(), [50_000_000n, 64_900_000n]],
        [daoAta.toBase58(), [0n, 100_000n]],
      ]),
    )
    const d = decodeTransaction('t22', tx, ctx(A))
    expect(d.trades.map((t) => [t.ixIndex, t.usdcDelta, t.yesDelta, t.fee])).toEqual([
      [0, -20_000_000n, 38_000_000n, 100_000n],
      [1, 5_000_000n, -10_000_000n, 0n],
    ])
    const whole = wholeTxFlows(tx, user.toBase58(), ctx(A))
    expect(d.trades.reduce((n, t) => n + t.usdcDelta, 0n)).toBe(whole.usdc)
    expect(d.trades.reduce((n, t) => n + t.yesDelta, 0n)).toBe(whole.yes)
    expect(d.trades.reduce((n, t) => n + t.fee, 0n)).toBe(whole.fee)
  })

  it('skips the row when a CPI names a program or account from a lookup table', () => {
    const fresh = () =>
      build(
        [claimIx(A), claimIx(B)],
        [
          {
            index: 0,
            ixs: [
              createTransferInstruction(A.vault, usdcAta, user, 1n),
              createBurnInstruction(yesAta(A), A.yes, user, 1n),
            ],
          },
          {
            index: 1,
            ixs: [
              createTransferInstruction(B.vault, usdcAta, user, 1n),
              createBurnInstruction(yesAta(B), B.yes, user, 1n),
            ],
          },
        ],
        [...accountsOf(A), ...accountsOf(B)],
      )
    const warn = vi.fn()
    const log = { warn } as unknown as Logger
    const skips: Array<[string, number]> = []
    const onSkip = (sig: string, ixIndex: number) => skips.push([sig, ixIndex])

    const programPast = fresh()
    const first = programPast.meta?.innerInstructions?.[0]?.instructions[0]
    if (first) first.programIdIndex = 200
    expect(decodeTransaction('lut', programPast, { ...ctx(A, log), onSkip }).claims).toEqual([])
    // The other instruction is unaffected.
    expect(decodeTransaction('lut', programPast, ctx(B, log)).claims).toHaveLength(1)

    const accountPast = fresh()
    const acct = accountPast.meta?.innerInstructions?.[0]?.instructions[0]
    if (acct) acct.accounts = [200, ...acct.accounts.slice(1)]
    expect(decodeTransaction('lut2', accountPast, { ...ctx(A, log), onSkip }).claims).toEqual([])

    expect(warn).toHaveBeenCalledTimes(2)
    expect(skips).toEqual([
      ['lut', 0],
      ['lut2', 0],
    ])
  })

  it('records a redeem and a lone claim from the whole-transaction delta', () => {
    const redeem = buildRedeemPairIx({
      user,
      market: A.market,
      collateralMint: DEVNET_MUSDC_MINT,
      amount: 3_000_000n,
    })
    const mine = accountsOf(A)
    const withBalances = (ix: TransactionInstruction) => {
      const tx = build([ix], undefined, mine)
      const keys = (tx.transaction.message as { staticAccountKeys: PublicKey[] }).staticAccountKeys
      const at = (k: PublicKey) => keys.findIndex((x) => x.equals(k))
      const tok = (k: PublicKey, owner: string, mint: string, n: bigint) =>
        bal(at(k), owner, mint, n)
      if (tx.meta) {
        tx.meta.preTokenBalances = [
          tok(usdcAta, user.toBase58(), usdc, 1_000_000n),
          tok(yesAta(A), user.toBase58(), A.yes.toBase58(), 3_000_000n),
          tok(noAta(A), user.toBase58(), A.no.toBase58(), 3_000_000n),
        ]
        tx.meta.postTokenBalances = [
          tok(usdcAta, user.toBase58(), usdc, 4_000_000n),
          tok(yesAta(A), user.toBase58(), A.yes.toBase58(), 0n),
          tok(noAta(A), user.toBase58(), A.no.toBase58(), 0n),
        ]
      }
      return tx
    }
    expect(decodeTransaction('r', withBalances(redeem), ctx(A)).claims).toEqual([
      expect.objectContaining({
        kind: 'redeem',
        usdcAmount: 3_000_000n,
        yesDelta: -3_000_000n,
        noDelta: -3_000_000n,
      }),
    ])
    expect(decodeTransaction('c', withBalances(claimIx(A)), ctx(A)).claims).toEqual([
      expect.objectContaining({ kind: 'claim', usdcAmount: 3_000_000n }),
    ])
  })

  describe('token flow invariants', () => {
    /** One pm-AMM payout instruction with the user's balance changes `d` (raw units). */
    const payout = (ix: TransactionInstruction, d: { usdc: bigint; yes: bigint; no: bigint }) => {
      const tx = build([ix], undefined, accountsOf(A))
      const keys = (tx.transaction.message as { staticAccountKeys: PublicKey[] }).staticAccountKeys
      const at = (k: PublicKey) => keys.findIndex((x) => x.equals(k))
      const tok = (k: PublicKey, owner: string, mint: string, n: bigint) =>
        bal(at(k), owner, mint, n)
      const held = 1_000_000_000n
      if (tx.meta) {
        tx.meta.preTokenBalances = [
          tok(usdcAta, user.toBase58(), usdc, held),
          tok(yesAta(A), user.toBase58(), A.yes.toBase58(), held),
          tok(noAta(A), user.toBase58(), A.no.toBase58(), held),
        ]
        tx.meta.postTokenBalances = [
          tok(usdcAta, user.toBase58(), usdc, held + d.usdc),
          tok(yesAta(A), user.toBase58(), A.yes.toBase58(), held + d.yes),
          tok(noAta(A), user.toBase58(), A.no.toBase58(), held + d.no),
        ]
      }
      return tx
    }
    const run = (
      tx: VersionedTransactionResponse,
      outcome?: 'yes' | 'no',
    ): {
      claims: ReturnType<typeof decodeTransaction>['claims']
      skips: Array<[string, number]>
      warns: number
    } => {
      const warn = vi.fn()
      const skips: Array<[string, number]> = []
      const market = { ...A.row, ...(outcome ? { outcome } : {}) } as MarketRow
      const d = decodeTransaction('sig', tx, {
        ...ctx(A, { warn } as unknown as Logger),
        market,
        onSkip: (sg, i) => skips.push([sg, i]),
      })
      return { claims: d.claims, skips, warns: warn.mock.calls.length }
    }
    const claim = () => claimIx(A)
    const redeem = () =>
      buildRedeemPairIx({ user, market: A.market, collateralMint: DEVNET_MUSDC_MINT, amount: 1n })

    it('records a claim whose payout is the burn of the winning side', () => {
      // YES won: 5 pays out 5 and the losing NO is burned too.
      const yesWon = payout(claim(), { usdc: 5_000_000n, yes: -5_000_000n, no: -2_000_000n })
      expect(run(yesWon, 'yes').claims).toHaveLength(1)
      expect(run(yesWon).claims).toHaveLength(1)
      // NO won, the user held only the winning side.
      const noWon = payout(claim(), { usdc: 7_000_000n, yes: 0n, no: -7_000_000n })
      expect(run(noWon, 'no').claims).toHaveLength(1)
      expect(run(noWon).claims).toHaveLength(1)
      // Only the losing side held: nothing is paid, the loser is burned.
      const loser = payout(claim(), { usdc: 0n, yes: -4_000_000n, no: 0n })
      expect(run(loser, 'no').claims).toHaveLength(1)
      expect(run(loser).claims).toHaveLength(1)
      // Both sides burned in equal amounts: the larger burn is the payout.
      const both = payout(claim(), { usdc: 3_000_000n, yes: -3_000_000n, no: -3_000_000n })
      expect(run(both).claims).toHaveLength(1)
    })

    it('skips the claim of the local run: a payout the winning side does not account for', () => {
      // Surfpool returned preTokenBalances without two accounts that existed: the whole-transaction
      // deltas read +520.76 mUSDC and no burn of the winning NO, only YES -7.87.
      const bad = payout(claim(), { usdc: 520_764_198n, yes: -7_870_556n, no: 0n })
      for (const outcome of ['no', undefined] as const) {
        const r = run(bad, outcome)
        expect(r.claims).toEqual([])
        expect(r.skips).toEqual([['sig', 0]])
        expect(r.warns).toBe(1)
      }
    })

    it('skips a claim whose losing side gained, or whose payout needs a side that did not burn', () => {
      expect(
        run(payout(claim(), { usdc: 5_000_000n, yes: -5_000_000n, no: 1n }), 'yes').claims,
      ).toEqual([])
      // The market says NO won, the flows pay a YES burn.
      expect(
        run(payout(claim(), { usdc: 5_000_000n, yes: -5_000_000n, no: 0n }), 'no').claims,
      ).toEqual([])
      // Both sides burned, neither equal to the payout.
      expect(
        run(payout(claim(), { usdc: 4_000_000n, yes: -5_000_000n, no: -3_000_000n })).claims,
      ).toEqual([])
      // Paid more than anything burned.
      expect(run(payout(claim(), { usdc: 1n, yes: 0n, no: 0n })).claims).toEqual([])
    })

    it('records a redeem of equal YES, NO and collateral, and skips one that is not', () => {
      const ok = run(payout(redeem(), { usdc: 3_000_000n, yes: -3_000_000n, no: -3_000_000n }))
      expect(ok.claims).toHaveLength(1)
      expect(ok.skips).toEqual([])
      for (const d of [
        { usdc: 3_000_000n, yes: -3_000_000n, no: -2_000_000n },
        { usdc: 3_000_001n, yes: -3_000_000n, no: -3_000_000n },
        { usdc: 3_000_000n, yes: 3_000_000n, no: -3_000_000n },
      ]) {
        const r = run(payout(redeem(), d))
        expect(r.claims).toEqual([])
        expect(r.skips).toEqual([['sig', 0]])
        expect(r.warns).toBe(1)
      }
    })
  })

  it('skips the row and warns when several instructions have no recorded CPIs', () => {
    const warn = vi.fn()
    const log = { warn } as unknown as Logger
    const noInner = build([claimIx(A), claimIx(B)], undefined, [...accountsOf(A), ...accountsOf(B)])
    expect(decodeTransaction('x', noInner, ctx(A, log)).claims).toEqual([])
    // Recorded for the other instruction only.
    const partial = build(
      [claimIx(A), claimIx(B)],
      [
        {
          index: 1,
          ixs: [
            createTransferInstruction(B.vault, usdcAta, user, 1n),
            createBurnInstruction(yesAta(B), B.yes, user, 1n),
          ],
        },
      ],
      [...accountsOf(A), ...accountsOf(B)],
    )
    expect(decodeTransaction('y', partial, ctx(A, log)).claims).toEqual([])
    expect(decodeTransaction('y', partial, ctx(B, log)).claims).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ market: A.row.pubkey, sig: 'x', ixIndex: 0 })
  })

  it('reports each skipped row to onSkip', () => {
    const skips: Array<[string, number]> = []
    const noInner = build([claimIx(A), claimIx(B)], undefined, [...accountsOf(A), ...accountsOf(B)])
    decodeTransaction('x', noInner, { ...ctx(A), onSkip: (sig, i) => skips.push([sig, i]) })
    expect(skips).toEqual([['x', 0]])
  })

  it('records the token accounts only for the sponsor paying for the user', () => {
    const sponsor = Keypair.generate().publicKey
    const stranger = Keypair.generate().publicKey
    const ata = yesAta(A)
    const swap = buildSwapIx({
      user,
      market: A.market,
      collateralMint: DEVNET_MUSDC_MINT,
      authority: program.authority,
      direction: 'usdcToYes',
      amountIn: 1n,
      minOut: 1n,
    })
    const make = (payer: PublicKey, owner: PublicKey) => {
      const tx = build(
        [swap, createAssociatedTokenAccountInstruction(payer, ata, owner, A.yes)],
        undefined,
        [],
        sponsor,
      )
      const keys = (tx.transaction.message as { staticAccountKeys: PublicKey[] }).staticAccountKeys
      if (tx.meta) {
        tx.meta.postTokenBalances = [
          bal(
            keys.findIndex((k) => k.equals(ata)),
            owner.toBase58(),
            A.yes.toBase58(),
            0n,
          ),
        ]
      }
      return tx
    }
    const withSponsor = { ...ctx(A), sponsor: sponsor.toBase58() }
    expect(decodeTransaction('a', make(sponsor, user), withSponsor).sponsoredAtas).toEqual([
      { ata: ata.toBase58(), wallet: user.toBase58(), mint: A.yes.toBase58() },
    ])
    // Someone else paid the rent, or the account is not the user's.
    expect(decodeTransaction('b', make(stranger, user), withSponsor).sponsoredAtas).toEqual([])
    expect(decodeTransaction('c', make(sponsor, stranger), withSponsor).sponsoredAtas).toEqual([])
  })
})
