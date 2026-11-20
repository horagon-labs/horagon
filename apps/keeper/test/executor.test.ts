import { type Connection, Keypair, SystemProgram } from '@solana/web3.js'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { telegramAlerter } from '../src/alerts'
import { ProgramFailure, TxSender } from '../src/executor'

const log = pino({ level: 'silent' })
const payer = Keypair.generate()
const ix = SystemProgram.transfer({
  fromPubkey: payer.publicKey,
  toPubkey: Keypair.generate().publicKey,
  lamports: 1,
})
const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'

interface Script {
  simulate?: Array<{ err: unknown; logs?: string[] }>
  send?: Array<Error | null>
}

function fakeConnection(script: Script) {
  const calls = { simulate: 0, send: 0, priorities: [] as number[] }
  const conn = {
    async getLatestBlockhash() {
      return { blockhash: BLOCKHASH, lastValidBlockHeight: 10 }
    },
    async simulateTransaction(tx: {
      message: { compiledInstructions: Array<{ data: Uint8Array }> }
    }) {
      const priceIx = tx.message.compiledInstructions[1]
      if (priceIx) calls.priorities.push(Number(Buffer.from(priceIx.data).readBigUInt64LE(1)))
      const r = script.simulate?.[calls.simulate] ?? { err: null }
      calls.simulate++
      return { context: { slot: 1 }, value: { err: r.err, logs: r.logs ?? [] } }
    },
    async sendRawTransaction() {
      const e = script.send?.[calls.send] ?? null
      calls.send++
      if (e) throw e
      return `sig${calls.send}`
    },
    async confirmTransaction() {
      return { context: { slot: 1 }, value: { err: null } }
    },
  }
  return { conn: conn as unknown as Connection, calls }
}

const alerts = () => {
  const sent: string[] = []
  return { sent, alerter: { send: async (key: string) => void sent.push(key) } }
}

describe('TxSender', () => {
  it('sends once when all goes well', async () => {
    const { conn, calls } = fakeConnection({})
    const s = new TxSender({
      connections: [conn],
      payer,
      log,
      alerts: alerts().alerter,
      sleep: async () => {},
    })
    const r = await s.send({
      label: 't',
      instructions: [ix],
      computeUnits: 10_000,
      priorityMicroLamports: 1_000,
    })
    expect(r).toEqual({ signature: 'sig1', attempts: 1, alreadyDone: false })
    expect(calls.priorities).toEqual([1_000])
  })

  it('retries transient failures with a doubling priority fee, alerting on the 4th failure', async () => {
    const boom = new Error('fetch failed')
    const { conn, calls } = fakeConnection({ send: [boom, boom, boom, boom, null] })
    const a = alerts()
    const sleeps: number[] = []
    const s = new TxSender({
      connections: [conn],
      payer,
      log,
      alerts: a.alerter,
      baseDelayMs: 100,
      sleep: async (ms) => void sleeps.push(ms),
    })
    const r = await s.send({
      label: 'halt x',
      instructions: [ix],
      computeUnits: 10_000,
      priorityMicroLamports: 1_000,
    })
    expect(r.attempts).toBe(5)
    expect(calls.priorities).toEqual([1_000, 2_000, 4_000, 8_000, 16_000])
    expect(sleeps.map((ms) => Math.floor(ms / 100) * 100)).toEqual([100, 200, 400, 800])
    expect(a.sent).toEqual(['tx:halt x'])
  })

  it('never retries a program error and names it', async () => {
    const logs = [
      `Program GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y failed: custom program error: 0x1777`,
    ]
    const { conn, calls } = fakeConnection({
      simulate: [{ err: { InstructionError: [2, { Custom: 6007 }] }, logs }],
    })
    const s = new TxSender({
      connections: [conn],
      payer,
      log,
      alerts: alerts().alerter,
      sleep: async () => {},
    })
    const p = s.send({
      label: 'x',
      instructions: [ix],
      computeUnits: 10_000,
      priorityMicroLamports: 1,
    })
    await expect(p).rejects.toBeInstanceOf(ProgramFailure)
    await expect(p).rejects.toMatchObject({ program: 'pm-amm', code: 6007 })
    expect(calls.simulate).toBe(1)
  })

  it('stops retrying once isDone sees the effect on chain', async () => {
    const { conn, calls } = fakeConnection({ send: [new Error('timeout')] })
    const s = new TxSender({
      connections: [conn],
      payer,
      log,
      alerts: alerts().alerter,
      sleep: async () => {},
    })
    const r = await s.send({
      label: 'x',
      instructions: [ix],
      computeUnits: 10_000,
      priorityMicroLamports: 1,
      isDone: async () => true,
    })
    expect(r).toEqual({ signature: null, attempts: 1, alreadyDone: true })
    expect(calls.send).toBe(1)
  })

  it('moves to the backup RPC on a 429', async () => {
    const primary = fakeConnection({ send: [new Error('429 Too Many Requests')] })
    const backup = fakeConnection({})
    const s = new TxSender({
      connections: [primary.conn, backup.conn],
      payer,
      log,
      alerts: alerts().alerter,
      sleep: async () => {},
    })
    const r = await s.send({
      label: 'x',
      instructions: [ix],
      computeUnits: 10_000,
      priorityMicroLamports: 1,
    })
    expect(r.signature).toBe('sig1')
    expect(backup.calls.send).toBe(1)
    expect(s.connection).toBe(backup.conn)
  })

  it('gives up after 5 attempts with the last error', async () => {
    const e = new Error('blockhash not found')
    const { conn } = fakeConnection({ send: [e, e, e, e, e] })
    const s = new TxSender({
      connections: [conn],
      payer,
      log,
      alerts: alerts().alerter,
      sleep: async () => {},
    })
    await expect(
      s.send({ label: 'x', instructions: [ix], computeUnits: 1, priorityMicroLamports: 1 }),
    ).rejects.toThrow(/gave up after 5 attempts: blockhash not found/)
  })

  it('keeps RPC URL keys out of logs and the final error', async () => {
    const e = new Error('failed to fetch https://rpc.example.com/v2/SECRETKEY?api-key=SECRETKEY')
    const { conn } = fakeConnection({ send: [e, e, e, e, e] })
    const lines: string[] = []
    const capture = pino({ level: 'trace' }, { write: (l: string) => void lines.push(l) })
    const s = new TxSender({
      connections: [conn],
      payer,
      log: capture,
      alerts: alerts().alerter,
      sleep: async () => {},
    })
    const err = await s
      .send({ label: 'x', instructions: [ix], computeUnits: 1, priorityMicroLamports: 1 })
      .catch((x: Error) => x)
    expect((err as Error).message).toContain('gave up after 5 attempts')
    expect((err as Error).message).not.toContain('SECRETKEY')
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join(',')).not.toContain('SECRETKEY')
  })
})

describe('telegramAlerter', () => {
  it('sends a key once per dedupe window and never throws', async () => {
    let t = 1_000
    const bodies: string[] = []
    const alerter = telegramAlerter({
      token: 'T',
      chatId: '42',
      log,
      prefix: '[devnet]',
      now: () => t,
      fetchImpl: (async (_url: string, init: { body: string }) => {
        bodies.push(init.body)
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch,
    })
    await alerter.send('halt:g1', 'Halted')
    await alerter.send('halt:g1', 'Halted')
    t += 601
    await alerter.send('halt:g1', 'Halted')
    expect(bodies).toHaveLength(2)
    expect(JSON.parse(bodies[0] ?? '{}')).toEqual({ chat_id: '42', text: '[devnet] Halted' })

    const down = telegramAlerter({
      token: 'T',
      chatId: '42',
      log,
      fetchImpl: (async () => {
        throw new Error('https://api.telegram.org/botT/sendMessage unreachable')
      }) as unknown as typeof fetch,
    })
    await expect(down.send('k', 'x')).resolves.toBeUndefined()
  })

  it('never logs the bot token, on a network error or a rejection', async () => {
    const lines: string[] = []
    const capture = pino({ level: 'trace' }, { write: (l: string) => void lines.push(l) })
    const down = telegramAlerter({
      token: 'BOTSECRET',
      chatId: '42',
      log: capture,
      fetchImpl: (async () => {
        throw new Error('https://api.telegram.org/botBOTSECRET/sendMessage unreachable')
      }) as unknown as typeof fetch,
    })
    await down.send('a', 'x')
    const rejected = telegramAlerter({
      token: 'BOTSECRET',
      chatId: '42',
      log: capture,
      fetchImpl: (async () => new Response('no', { status: 401 })) as unknown as typeof fetch,
    })
    await rejected.send('b', 'x')
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join(',')).not.toContain('BOTSECRET')
  })
})
