import { createPublicKey, verify } from 'node:crypto'
import { HoragonError, type TradeBuildRequest, type TxStatus } from '@horagon/sdk'
import {
  Keypair,
  MessageV0,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js'
import { Buffer } from 'buffer'
import { describe, expect, it } from 'vitest'
import {
  claimAll,
  executeTrade,
  failedSignature,
  type TradeClient,
  type TradeStage,
} from '../lib/trade'

const sponsor = Keypair.generate()
const user = Keypair.generate()
const SIG = '5'.repeat(88)

/** An unsigned sponsored tx: sponsor pays, the user signs the instruction. */
function unsignedTx(): string {
  const ix = new TransactionInstruction({
    programId: SystemProgram.programId,
    keys: [{ pubkey: user.publicKey, isSigner: true, isWritable: true }],
    data: Buffer.alloc(0),
  })
  const message = MessageV0.compile({
    payerKey: sponsor.publicKey,
    instructions: [ix],
    recentBlockhash: '11111111111111111111111111111111',
  })
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64')
}

const REQ: TradeBuildRequest = {
  market: sponsor.publicKey.toBase58(),
  side: 'home',
  action: 'buy',
  amount: '10',
  wallet: user.publicKey.toBase58(),
}

type Step = 'ok' | HoragonError | TxStatus['error']

/** What the SDK does when the sponsor's answer is lost: a NETWORK error that names the signature. */
function withSignature(err: HoragonError, signature: string): HoragonError {
  Object.defineProperty(err, 'signature', { value: signature, enumerable: true })
  return err
}

interface Script {
  /** One entry per `trade.build` call: ok, or an error to throw. */
  builds?: Step[]
  /** One entry per `trade.submit` call: ok, or an error to throw. */
  submits?: Step[]
  /** One entry per `trade.waitFor` call: ok, a failed status error, or an error to throw. */
  chain?: Step[]
}

function fakeClient({ builds = [], submits = [], chain = [] }: Script = {}) {
  const built: TradeBuildRequest[] = []
  const submitted: string[] = []
  const client = {
    trade: {
      build: async (req: TradeBuildRequest) => {
        built.push(req)
        const step = builds.shift() ?? 'ok'
        if (step instanceof HoragonError) throw step
        return { tx: unsignedTx(), feePayer: sponsor.publicKey.toBase58(), expiresAt: 0 }
      },
      submit: async (tx: string) => {
        submitted.push(tx)
        const step = submits.shift() ?? 'ok'
        if (step instanceof HoragonError) throw step
        return SIG
      },
      status: async () => {
        throw new Error('unused')
      },
      waitFor: async (signature: string): Promise<TxStatus> => {
        const step = chain.shift() ?? 'ok'
        if (step instanceof HoragonError) throw step
        return step === 'ok'
          ? { signature, status: 'confirmed', slot: 1, error: null }
          : { signature, status: 'failed', slot: 1, error: step }
      },
    },
    claims: {
      build: async () => ({
        txs: [unsignedTx(), unsignedTx()].map((tx) => ({
          tx,
          feePayer: sponsor.publicKey.toBase58(),
          expiresAt: 0,
        })),
        markets: [],
      }),
    },
  } as unknown as TradeClient
  return { client, built, submitted }
}

const slippage = () => new HoragonError('SLIPPAGE_EXCEEDED', 'price moved', { programCode: 6007 })
const landedSlippage = { code: 'SLIPPAGE_EXCEEDED', message: 'x', programCode: 6007 } as const

describe('executeTrade', () => {
  it('builds, signs as the user only, submits and waits, in that order', async () => {
    const { client, built, submitted } = fakeClient()
    const stages: TradeStage[] = []
    const r = await executeTrade(client, user, REQ, (s) => stages.push(s))
    expect(stages).toEqual(['building', 'signing', 'submitting', 'confirming'])
    expect(r).toMatchObject({ signature: SIG, requoted: false })
    expect(built[0]?.slippageBps).toBe(200)

    const tx = VersionedTransaction.deserialize(Buffer.from(submitted[0] ?? '', 'base64'))
    expect(tx.signatures[0]?.every((b) => b === 0)).toBe(true)
    const x = Buffer.from(user.publicKey.toBytes()).toString('base64url')
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })
    const sig = tx.signatures[1] ?? new Uint8Array(64)
    expect(verify(null, tx.message.serialize(), key, sig)).toBe(true)
  })

  it('keeps an explicit slippage', async () => {
    const { client, built } = fakeClient()
    await executeTrade(client, user, { ...REQ, slippageBps: 500 })
    expect(built[0]?.slippageBps).toBe(500)
  })

  it('re-quotes exactly once when the build itself fails with slippage', async () => {
    const { client, built, submitted } = fakeClient({ builds: [slippage()] })
    const stages: TradeStage[] = []
    const r = await executeTrade(client, user, REQ, (s) => stages.push(s))
    expect(built).toHaveLength(2)
    expect(submitted).toHaveLength(1)
    expect(r.requoted).toBe(true)
    expect(stages).toContain('requoting')
  })

  it('re-quotes exactly once when a landed transaction failed with slippage', async () => {
    const { client, built, submitted } = fakeClient({ chain: [landedSlippage] })
    await expect(executeTrade(client, user, REQ)).resolves.toMatchObject({ requoted: true })
    expect(built).toHaveLength(2)
    expect(submitted).toHaveLength(2)
  })

  it('throws a second slippage failure instead of re-quoting again', async () => {
    const { client, built } = fakeClient({ chain: [landedSlippage, landedSlippage] })
    await expect(executeTrade(client, user, REQ)).rejects.toMatchObject({
      code: 'SLIPPAGE_EXCEEDED',
    })
    expect(built).toHaveLength(2)

    const again = fakeClient({ builds: ['ok', slippage()], chain: [landedSlippage] })
    await expect(executeTrade(again.client, user, REQ)).rejects.toMatchObject({
      code: 'SLIPPAGE_EXCEEDED',
    })
    expect(again.built).toHaveLength(2)
  })

  it('keeps the hint of a landed failure', async () => {
    const { client } = fakeClient({
      chain: [{ code: 'PROGRAM_ERROR', message: 'Plain words.', hint: 'Refresh and retry.' }],
    })
    await expect(executeTrade(client, user, REQ)).rejects.toMatchObject({
      message: 'Plain words.',
      hint: 'Refresh and retry.',
    })
  })

  it('does not retry other failures and keeps their code', async () => {
    const { client, built } = fakeClient({ chain: [{ code: 'MARKET_HALTED', message: 'halted' }] })
    await expect(executeTrade(client, user, REQ)).rejects.toMatchObject({ code: 'MARKET_HALTED' })
    expect(built).toHaveLength(1)
  })

  it('never resends or re-quotes after a failed submit, and rethrows it unchanged', async () => {
    const lost = withSignature(new HoragonError('NETWORK', 'answer lost'), SIG)
    const { client, built, submitted } = fakeClient({ submits: [lost] })
    const err = await executeTrade(client, user, REQ).catch((e: unknown) => e)
    expect(err).toBe(lost)
    expect(failedSignature(err)).toBe(SIG)
    expect(built).toHaveLength(1)
    expect(submitted).toHaveLength(1)
  })

  it('re-quotes once when the sponsor simulation refuses with slippage and no signature', async () => {
    const { client, built, submitted } = fakeClient({ submits: [slippage()] })
    const stages: TradeStage[] = []
    const r = await executeTrade(client, user, REQ, (s) => stages.push(s))
    expect(built).toHaveLength(2)
    expect(submitted).toHaveLength(2)
    expect(r.requoted).toBe(true)
    expect(stages).toContain('requoting')
  })

  it('throws a second submit-time slippage instead of re-quoting again', async () => {
    const { client, built, submitted } = fakeClient({ submits: [slippage(), slippage()] })
    await expect(executeTrade(client, user, REQ)).rejects.toMatchObject({
      code: 'SLIPPAGE_EXCEEDED',
    })
    expect(built).toHaveLength(2)
    expect(submitted).toHaveLength(2)
  })

  it('rethrows a submit slippage that names a signature by identity, without re-quoting', async () => {
    const err = withSignature(slippage(), SIG)
    const { client, built, submitted } = fakeClient({ submits: [err] })
    await expect(executeTrade(client, user, REQ)).rejects.toBe(err)
    expect(built).toHaveLength(1)
    expect(submitted).toHaveLength(1)
    expect(failedSignature(err)).toBe(SIG)
  })

  it('keeps the signature readable when waiting times out, and does not resend', async () => {
    const timeout = new HoragonError('NETWORK', `${SIG} not confirmed in time`)
    const { client, built, submitted } = fakeClient({ chain: [timeout] })
    const err = await executeTrade(client, user, REQ).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'NETWORK' })
    expect(failedSignature(err)).toBe(SIG)
    expect(built).toHaveLength(1)
    expect(submitted).toHaveLength(1)
  })

  it('treats a wait that ends without a final status like a timeout', async () => {
    const { client, built, submitted } = fakeClient()
    client.trade.waitFor = async (signature) => ({
      signature,
      status: 'unknown',
      slot: null,
      error: null,
    })
    const err = await executeTrade(client, user, REQ).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'NETWORK' })
    expect(failedSignature(err)).toBe(SIG)
    expect(built).toHaveLength(1)
    expect(submitted).toHaveLength(1)
  })

  it('names the signature on a non-SDK error thrown while waiting', async () => {
    const odd = new Error('boom')
    const { client, built, submitted } = fakeClient()
    client.trade.waitFor = async () => {
      throw odd
    }
    const err = await executeTrade(client, user, REQ).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'NETWORK', message: 'boom' })
    expect(failedSignature(err)).toBe(SIG)
    expect(built).toHaveLength(1)
    expect(submitted).toHaveLength(1)
  })
})

describe('failedSignature', () => {
  it('is null for anything without an SDK signature', () => {
    expect(failedSignature(new Error('x'))).toBeNull()
    expect(failedSignature(new HoragonError('NETWORK', 'x'))).toBeNull()
    expect(failedSignature({ signature: SIG })).toBeNull()
    expect(failedSignature(undefined)).toBeNull()
  })
})

describe('claimAll', () => {
  it('signs and submits every claim transaction in order', async () => {
    const { client, submitted } = fakeClient()
    await expect(claimAll(client, user)).resolves.toEqual([SIG, SIG])
    expect(submitted).toHaveLength(2)
  })

  it('stops at the first failure and rethrows it without sending the rest', async () => {
    const lost = withSignature(new HoragonError('NETWORK', 'answer lost'), SIG)
    const { client, submitted } = fakeClient({ submits: [lost] })
    const err = await claimAll(client, user).catch((e: unknown) => e)
    expect(err).toBe(lost)
    expect(failedSignature(err)).toBe(SIG)
    expect(submitted).toHaveLength(1)
  })

  it('reports each landed claim as it lands, so a later failure keeps them (R2)', async () => {
    const lost = withSignature(new HoragonError('NETWORK', 'answer lost'), SIG)
    const { client, submitted } = fakeClient({ submits: ['ok', lost] })
    const landed: string[] = []
    const err = await claimAll(client, user, (sig) => landed.push(sig)).catch((e: unknown) => e)
    expect(err).toBe(lost)
    expect(landed).toEqual([SIG])
    expect(submitted).toHaveLength(2)
  })
})
