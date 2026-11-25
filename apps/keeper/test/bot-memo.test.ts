import {
  type DbHandle,
  insertTrades,
  listMarketTrades,
  type MarketRow,
  upsertMarket,
  upsertScheduledGames,
} from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import {
  botMemoIx,
  buildSwapIx,
  DEVNET_MUSDC_MINT,
  HoragonProgram,
  MEMO_PROGRAM_ID,
} from '@horagon/sdk'
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  type VersionedMessage,
  type VersionedTransactionResponse,
} from '@solana/web3.js'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeTransaction, hasBotMemo, type IndexerDeps, indexOnce } from '../src/indexer'
import { backfillBotMemo } from '../src/ops/backfill-bot-memo'

const program = new HoragonProgram({ collateralMint: DEVNET_MUSDC_MINT })
const sponsor = Keypair.generate().publicKey
const user = Keypair.generate().publicKey
const market = Keypair.generate().publicKey
const yesMint = Keypair.generate().publicKey.toBase58()
const noMint = Keypair.generate().publicKey.toBase58()
const usdc = DEVNET_MUSDC_MINT.toBase58()
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'
const LEGACY_MEMO = new PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo')

const memo = (text: string, opts: { program?: PublicKey; signer?: PublicKey } = {}) =>
  new TransactionInstruction({
    programId: opts.program ?? MEMO_PROGRAM_ID,
    keys: opts.signer ? [{ pubkey: opts.signer, isSigner: true, isWritable: false }] : [],
    data: Buffer.from(text, 'utf8'),
  })

/** A sponsored swap on `market`, with `extra` instructions before it. */
function swapMessage(extra: TransactionInstruction[] = []): VersionedMessage {
  const swap = buildSwapIx({
    user,
    market,
    collateralMint: DEVNET_MUSDC_MINT,
    authority: program.authority,
    direction: 'usdcToYes',
    amountIn: 20_000_000n,
    minOut: 1n,
  })
  return new TransactionMessage({
    payerKey: sponsor,
    recentBlockhash: BLOCKHASH,
    instructions: [...extra, swap],
  }).compileToV0Message()
}

const bal = (accountIndex: number, owner: string, mint: string, amount: bigint) => ({
  accountIndex,
  owner,
  mint,
  uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: null, uiAmountString: '' },
})

function response(
  message: VersionedMessage,
  sig: string,
  blockTime = 1_795_000_000,
): VersionedTransactionResponse {
  return {
    slot: 77,
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
  } as unknown as VersionedTransactionResponse
}

describe('hasBotMemo', () => {
  it.each<[string, TransactionInstruction[], boolean]>([
    ['the horagon:bot memo', [botMemoIx()], true],
    ['no memo', [], false],
    ['another text', [memo('horagon:bots')], false],
    ['an empty memo', [memo('')], false],
    ['a memo with an account', [memo('horagon:bot', { signer: user })], false],
    ['the legacy Memo program', [memo('horagon:bot', { program: LEGACY_MEMO })], false],
  ])('%s', (_label, extra, expected) => {
    expect(hasBotMemo(response(swapMessage(extra), 'sigA'))).toBe(expected)
  })
})

describe('decodeTransaction', () => {
  const ctx = {
    market: {
      pubkey: market.toBase58(),
      gameId: 'nba-1',
      yesMint,
      noMint,
      externalLp: false,
    } as MarketRow,
    collateralMint: usdc,
    authority: program.authority.toBase58(),
  }

  it('marks each trade with the memo of its transaction', () => {
    const bot = decodeTransaction('sigA', response(swapMessage([botMemoIx()]), 'sigA'), ctx)
    expect(bot.trades.map((t) => t.botMemo)).toEqual([true])
    const plain = decodeTransaction('sigB', response(swapMessage(), 'sigB'), ctx)
    expect(plain.trades.map((t) => t.botMemo)).toEqual([false])
  })
})

describe('indexOnce', () => {
  let h: DbHandle
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
      endTs: new Date('2026-11-25T02:10:00Z'),
      seedAmount: 1_000_000n,
      status: 'halted',
    })
  })
  afterEach(async () => {
    await h.close()
  })

  it('stores bot_memo with each trade it indexes', async () => {
    const chain = new Map([
      ['s1', response(swapMessage(), 's1', 1_795_000_001)],
      ['s2', response(swapMessage([botMemoIx()]), 's2', 1_795_000_002)],
    ])
    const deps: IndexerDeps = {
      db: h.db,
      collateralMint: DEVNET_MUSDC_MINT,
      authority: program.authority,
      alerts: { send: async () => undefined },
      log: { warn: () => undefined, info: () => undefined } as unknown as Logger,
      now: () => Date.parse('2026-11-25T03:00:00Z') / 1000,
      stops: new Map(),
      connection: {
        // Newest first, like the RPC.
        getSignaturesForAddress: async () =>
          ['s2', 's1'].map((signature) => ({ signature, err: null })),
        getTransactions: async (sigs: string[]) => sigs.map((s) => chain.get(s) ?? null),
        getMultipleAccountsInfo: async () => [],
      } as unknown as IndexerDeps['connection'],
    }
    expect(await indexOnce(deps)).toMatchObject({ trades: 2 })
    const rows = await listMarketTrades(h.db, [market.toBase58()])
    expect(rows.map((t) => [t.sig, t.botMemo])).toEqual([
      ['s1', false],
      ['s2', true],
    ])
  })
})

describe('backfillBotMemo', () => {
  let h: DbHandle
  let chain: Map<string, VersionedTransactionResponse | null>
  let calls: string[][]
  beforeEach(async () => {
    h = await createTestDb()
    chain = new Map()
    calls = []
  })
  afterEach(async () => {
    await h.close()
  })

  /** A trade row indexed before bot_memo existed (null), unless `botMemo` is given. */
  const row = (sig: string, ixIndex: number, second: number, botMemo?: boolean) => ({
    sig,
    ixIndex,
    market: market.toBase58(),
    wallet: user.toBase58(),
    direction: 'usdcToYes',
    usdcAmount: 20_000_000n,
    usdcDelta: -20_000_000n,
    yesDelta: 38_721_969n,
    noDelta: 0n,
    fee: 0n,
    slot: BigInt(second),
    blockTime: new Date((1_795_000_000 + second) * 1000),
    ...(botMemo === undefined ? {} : { botMemo }),
  })
  const onChain = (sig: string, bot: boolean) => {
    chain.set(sig, response(swapMessage(bot ? [botMemoIx()] : []), sig))
  }
  const deps = () => ({
    db: h.db,
    getTransactions: async (sigs: string[]) => {
      calls.push(sigs)
      return sigs.map((s) => chain.get(s) ?? null)
    },
  })
  const memos = async () =>
    (await listMarketTrades(h.db, [market.toBase58()])).map((t) => [t.sig, t.ixIndex, t.botMemo])

  it('reads each unset transaction once and sets every row of it', async () => {
    await insertTrades(h.db, [row('s1', 2, 1), row('s1', 3, 1), row('s2', 2, 2), row('s3', 2, 3)])
    onChain('s1', true)
    onChain('s2', false)
    onChain('s3', true)
    expect(await backfillBotMemo(deps())).toEqual({ read: 3, bots: 2, left: 0 })
    expect(calls).toEqual([['s1', 's2', 's3']])
    expect(await memos()).toEqual([
      ['s1', 2, true],
      ['s1', 3, true],
      ['s2', 2, false],
      ['s3', 2, true],
    ])
  })

  it('is safe to run again: nothing left, nothing read', async () => {
    await insertTrades(h.db, [row('s1', 2, 1)])
    onChain('s1', true)
    await backfillBotMemo(deps())
    calls = []
    expect(await backfillBotMemo(deps())).toEqual({ read: 0, bots: 0, left: 0 })
    expect(calls).toEqual([])
  })

  it('leaves rows the indexer already set alone', async () => {
    await insertTrades(h.db, [row('s1', 2, 1, false), row('s2', 2, 2)])
    onChain('s1', true)
    onChain('s2', false)
    expect(await backfillBotMemo(deps())).toEqual({ read: 1, bots: 0, left: 0 })
    expect(calls).toEqual([['s2']])
    expect(await memos()).toEqual([
      ['s1', 2, false],
      ['s2', 2, false],
    ])
  })

  it('stops at a transaction the RPC cannot return, keeping what it wrote', async () => {
    await insertTrades(h.db, [row('s1', 2, 1), row('s2', 2, 2), row('s3', 2, 3)])
    onChain('s1', true)
    chain.set('s2', null)
    onChain('s3', false)
    await expect(backfillBotMemo(deps())).rejects.toThrow(
      'transaction s2 is not available from the RPC; run again later',
    )
    expect(await memos()).toEqual([
      ['s1', 2, true],
      ['s2', 2, null],
      ['s3', 2, null],
    ])
    onChain('s2', false)
    expect(await backfillBotMemo(deps())).toEqual({ read: 2, bots: 0, left: 0 })
  })

  it('refuses a response for another transaction', async () => {
    await insertTrades(h.db, [row('s1', 2, 1)])
    chain.set('s1', response(swapMessage(), 'other'))
    await expect(backfillBotMemo(deps())).rejects.toThrow(
      'the RPC returned another transaction for s1',
    )
    expect(await memos()).toEqual([['s1', 2, null]])
  })

  it('reads in batches of the size it is given, logging each', async () => {
    await insertTrades(
      h.db,
      [1, 2, 3, 4, 5].map((i) => row(`s${i}`, 2, i)),
    )
    for (const i of [1, 2, 3, 4, 5]) onChain(`s${i}`, i === 4)
    const lines: string[] = []
    const result = await backfillBotMemo({ ...deps(), log: (line) => lines.push(line) }, 2)
    expect(result).toEqual({ read: 5, bots: 1, left: 0 })
    expect(calls).toEqual([['s1', 's2'], ['s3', 's4'], ['s5']])
    expect(lines).toEqual([
      'bot_memo: 2 transactions read, 0 with the bot memo',
      'bot_memo: 4 transactions read, 1 with the bot memo',
      'bot_memo: 5 transactions read, 1 with the bot memo',
    ])
  })

  it('refuses a batch size below 1', async () => {
    await expect(backfillBotMemo(deps(), 0)).rejects.toThrow('batch must be a positive integer')
  })
})
