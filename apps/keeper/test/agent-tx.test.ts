import {
  ataAddress,
  BOT_MEMO,
  DEVNET_MUSDC_MINT,
  deriveMarketPda,
  deriveNoMint,
  deriveYesMint,
  HoragonProgram,
  isBotMemoInstruction,
  MEMO_PROGRAM_ID,
  PM_AMM_IX_DISCRIMINATORS,
  PM_AMM_PROGRAM_ID,
  SWAP_COMPUTE_UNITS,
  tradeAtas,
} from '@horagon/sdk'
import {
  ComputeBudgetProgram,
  type Connection,
  Keypair,
  type VersionedTransaction,
  type VersionedTransactionResponse,
  VersionedTransaction as VTx,
} from '@solana/web3.js'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { agentClaimInstructions, agentSwapInstructions, instructionsOf } from '../src/agent/tx'
import { TxSender } from '../src/executor'
import { hasBotMemo } from '../src/indexer'

const agent = Keypair.generate()
const sponsor = Keypair.generate()
const program = new HoragonProgram({ collateralMint: DEVNET_MUSDC_MINT })
const market = deriveMarketPda(42n)
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'

/** A chain that accepts everything and keeps the bytes it was sent. */
function recordingConnection() {
  const sent: VersionedTransaction[] = []
  const conn = {
    async getLatestBlockhash() {
      return { blockhash: BLOCKHASH, lastValidBlockHeight: 10 }
    },
    async simulateTransaction() {
      return { context: { slot: 1 }, value: { err: null, logs: [] } }
    },
    async sendRawTransaction(raw: Uint8Array) {
      sent.push(VTx.deserialize(raw))
      return `sig${sent.length}`
    },
    async confirmTransaction() {
      return { context: { slot: 1 }, value: { err: null } }
    },
    async getBlockHeight() {
      return 1
    },
    async getSignatureStatuses(sigs: string[]) {
      return { context: { slot: 1 }, value: sigs.map(() => null) }
    },
  }
  return { conn: conn as unknown as Connection, sent }
}

async function sendThroughKeeper(instructions: ReturnType<typeof agentSwapInstructions>) {
  const { conn, sent } = recordingConnection()
  const alerts = { send: async () => {} }
  const sender = new TxSender({
    connections: [conn],
    payer: agent,
    log: pino({ level: 'silent' }),
    alerts,
  })
  await sender.send({
    label: 'swap nba-1',
    instructions,
    computeUnits: SWAP_COMPUTE_UNITS,
    priorityMicroLamports: 10_000,
  })
  expect(sent).toHaveLength(1)
  return sent[0] as VersionedTransaction
}

const swapIxs = (createAtas = true) => {
  const atas = tradeAtas({
    user: agent.publicKey,
    market,
    collateralMint: DEVNET_MUSDC_MINT,
    authority: program.authority,
  })
  return agentSwapInstructions({
    agent: agent.publicKey,
    market,
    collateralMint: DEVNET_MUSDC_MINT,
    authority: program.authority,
    direction: 'usdcToYes',
    amountIn: 25_000_000n,
    minOut: 30_000_000n,
    // The YES and NO ATAs are new on the agent's first swap of a market.
    createAtas: createAtas ? atas.slice(1, 3) : [],
  })
}

const programsOf = (tx: VersionedTransaction) =>
  tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex])

describe('the agent swap transaction', () => {
  it('carries the top-level horagon:bot memo, exactly, with no accounts, right before the swap', async () => {
    const tx = await sendThroughKeeper(swapIxs())
    const keys = tx.message.staticAccountKeys
    const memos = tx.message.compiledInstructions.filter((ix) =>
      keys[ix.programIdIndex]?.equals(MEMO_PROGRAM_ID),
    )
    expect(memos).toHaveLength(1)
    const memo = memos[0] as (typeof memos)[number]
    expect(memo.accountKeyIndexes).toEqual([])
    expect(Buffer.from(memo.data).toString('utf8')).toBe(BOT_MEMO)
    expect(BOT_MEMO).toBe('horagon:bot')
    expect(isBotMemoInstruction(MEMO_PROGRAM_ID, 0, memo.data)).toBe(true)
    const programs = programsOf(tx)
    const memoAt = tx.message.compiledInstructions.indexOf(memo)
    expect(programs[memoAt + 1]?.equals(PM_AMM_PROGRAM_ID)).toBe(true)
    // The indexer and docs/metrics.md read it as a bot transaction.
    expect(
      hasBotMemo({
        transaction: { message: tx.message },
      } as unknown as VersionedTransactionResponse),
    ).toBe(true)
  })

  it('is paid for and signed by the agent alone: no sponsor key', async () => {
    const tx = await sendThroughKeeper(swapIxs())
    const keys = tx.message.staticAccountKeys
    expect(keys[0]?.equals(agent.publicKey)).toBe(true)
    expect(tx.message.header.numRequiredSignatures).toBe(1)
    expect(tx.signatures).toHaveLength(1)
    expect(keys.some((k) => k.equals(sponsor.publicKey))).toBe(false)
    // Every ATA create is paid by the agent.
    for (const ix of instructionsOf(tx)) {
      if (ix.programId.equals(PM_AMM_PROGRAM_ID) || ix.programId.equals(MEMO_PROGRAM_ID)) continue
      expect(ix.keys[0]?.pubkey.equals(agent.publicKey), ix.programId.toBase58()).toBe(true)
    }
  })

  it('has one compute budget, the swap, and the creates of the missing ATAs only', async () => {
    const tx = await sendThroughKeeper(swapIxs())
    const programs = programsOf(tx)
    expect(programs.filter((p) => p?.equals(ComputeBudgetProgram.programId))).toHaveLength(2)
    const swap = tx.message.compiledInstructions.at(-1)
    expect(programs.at(-1)?.equals(PM_AMM_PROGRAM_ID)).toBe(true)
    expect([...(swap?.data.subarray(0, 8) ?? [])]).toEqual([...PM_AMM_IX_DISCRIMINATORS.swap])
    // [limit, price, create YES ATA, create NO ATA, memo, swap]
    expect(programs).toHaveLength(6)
    const noCreates = await sendThroughKeeper(swapIxs(false))
    expect(programsOf(noCreates)).toHaveLength(4)
  })

  it('swaps the amount and min_out it was given, for the agent', () => {
    const swap = swapIxs(false).at(-1)
    expect(swap?.programId.equals(PM_AMM_PROGRAM_ID)).toBe(true)
    expect(swap?.keys[0]?.pubkey.equals(agent.publicKey)).toBe(true)
    expect(swap?.keys[0]?.isSigner).toBe(true)
    const data = Buffer.from(swap?.data ?? [])
    expect(data[8]).toBe(0) // usdcToYes
    expect(data.readBigUInt64LE(9)).toBe(25_000_000n)
    expect(data.readBigUInt64LE(17)).toBe(30_000_000n)
  })
})

describe('the agent claim', () => {
  it('is claim_winnings with the missing ATA created first, and no memo', () => {
    const ixs = agentClaimInstructions({
      agent: agent.publicKey,
      market,
      collateralMint: DEVNET_MUSDC_MINT,
      createAtas: [{ owner: agent.publicKey, mint: deriveNoMint(market) }],
    })
    expect(ixs).toHaveLength(2)
    expect(ixs.some((ix) => ix.programId.equals(MEMO_PROGRAM_ID))).toBe(false)
    const claim = ixs[1]
    expect(claim?.programId.equals(PM_AMM_PROGRAM_ID)).toBe(true)
    expect([...(claim?.data.subarray(0, 8) ?? [])]).toEqual([
      ...PM_AMM_IX_DISCRIMINATORS.claimWinnings,
    ])
    expect(claim?.keys[0]?.pubkey.equals(agent.publicKey)).toBe(true)
    expect(
      claim?.keys.some((k) =>
        k.pubkey.equals(ataAddress({ owner: agent.publicKey, mint: deriveYesMint(market) })),
      ),
    ).toBe(true)
  })
})
