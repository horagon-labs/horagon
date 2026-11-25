import { Buffer } from 'node:buffer'
import { Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { DEVNET_MUSDC_MINT, PM_AMM_PROGRAM_ID } from '../../src/pm-amm/constants'
import { TradeBuildRequestSchema } from '../../src/schemas'
import { BOT_MEMO, botMemoIx, isBotMemoInstruction, MEMO_PROGRAM_ID } from '../../src/tx/memo'
import { buildTradeTransaction, MAX_TX_BYTES, tradeAtas } from '../../src/tx/trade'

const user = Keypair.generate().publicKey
const sponsor = Keypair.generate().publicKey
const market = Keypair.generate().publicKey
const authority = Keypair.generate().publicKey
const LEGACY_MEMO = new PublicKey('Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo')

/** A sponsored buy that creates all five ATAs and pays a priority fee: the largest trade. */
function trade(botMemo?: boolean): VersionedTransaction {
  const swap = {
    user,
    market,
    collateralMint: DEVNET_MUSDC_MINT,
    authority,
    direction: 'usdcToYes' as const,
    amountIn: 20_000_000n,
    minOut: 1n,
  }
  return buildTradeTransaction({
    feePayer: sponsor,
    recentBlockhash: PublicKey.default.toBase58(),
    swap,
    createAtas: tradeAtas(swap),
    microLamportsPerCu: 1_000,
    ...(botMemo === undefined ? {} : { botMemo }),
  })
}

const programsOf = (tx: VersionedTransaction) =>
  tx.message.compiledInstructions.map((ix) =>
    tx.message.staticAccountKeys[ix.programIdIndex]?.toBase58(),
  )

describe('the horagon:bot memo', () => {
  it('is an SPL Memo v2 instruction with no accounts and the exact text', () => {
    expect(MEMO_PROGRAM_ID.toBase58()).toBe('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
    expect(BOT_MEMO).toBe('horagon:bot')
    const ix = botMemoIx()
    expect(ix.programId.equals(MEMO_PROGRAM_ID)).toBe(true)
    expect(ix.keys).toEqual([])
    expect(Buffer.from(ix.data).toString('utf8')).toBe('horagon:bot')
  })

  it.each([
    ['the bot memo', MEMO_PROGRAM_ID, 0, 'horagon:bot', true],
    ['a trailing space', MEMO_PROGRAM_ID, 0, 'horagon:bot ', false],
    ['a prefix of it', MEMO_PROGRAM_ID, 0, 'horagon:bo', false],
    ['upper case', MEMO_PROGRAM_ID, 0, 'HORAGON:BOT', false],
    ['an empty memo', MEMO_PROGRAM_ID, 0, '', false],
    ['one account', MEMO_PROGRAM_ID, 1, 'horagon:bot', false],
    ['the legacy Memo program', LEGACY_MEMO, 0, 'horagon:bot', false],
    ['another program', PM_AMM_PROGRAM_ID, 0, 'horagon:bot', false],
  ] as const)('isBotMemoInstruction: %s', (_label, program, accounts, text, expected) => {
    expect(isBotMemoInstruction(program, accounts, Buffer.from(text, 'utf8'))).toBe(expected)
  })
})

describe('buildTradeTransaction with botMemo', () => {
  it('puts one memo right before the swap, which stays last', () => {
    const programs = programsOf(trade(true))
    expect(programs.at(-1)).toBe(PM_AMM_PROGRAM_ID.toBase58())
    expect(programs.at(-2)).toBe(MEMO_PROGRAM_ID.toBase58())
    expect(programs.filter((p) => p === MEMO_PROGRAM_ID.toBase58())).toHaveLength(1)
  })

  it('adds no memo unless asked', () => {
    expect(programsOf(trade())).not.toContain(MEMO_PROGRAM_ID.toBase58())
    expect(programsOf(trade(false))).not.toContain(MEMO_PROGRAM_ID.toBase58())
  })

  it('still fits one transaction with all five ATAs and a priority fee', () => {
    const size = trade(true).serialize().length
    expect(size).toBeLessThanOrEqual(MAX_TX_BYTES)
    expect(size - trade(false).serialize().length).toBeLessThan(64)
  })
})

describe('TradeBuildRequestSchema client', () => {
  const base = {
    market: PublicKey.default.toBase58(),
    side: 'home',
    action: 'buy',
    amount: '20',
    wallet: user.toBase58(),
  }

  it('takes client "bot", or no client', () => {
    expect(TradeBuildRequestSchema.parse({ ...base, client: 'bot' }).client).toBe('bot')
    expect(TradeBuildRequestSchema.parse(base).client).toBeUndefined()
  })

  it.each(['web', 'BOT', '', 1])('refuses client %j', (client) => {
    expect(TradeBuildRequestSchema.safeParse({ ...base, client }).success).toBe(false)
  })
})
