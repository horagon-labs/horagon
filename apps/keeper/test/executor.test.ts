import { HORAGON_PROGRAM_ID } from '@horagon/sdk'
import {
  type Connection,
  Keypair,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { logAlerter, telegramAlerter } from '../src/alerts'
import {
  base58,
  ProgramFailure,
  TxSender,
  type TxSenderOptions,
  UnresolvedAttempt,
} from '../src/executor'

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
  confirm?: Array<Error | { err: unknown } | null>
  /** When set the fake exposes getSignatureStatuses; it gets the signatures asked about. */
  statuses?: (sigs: string[]) => Array<{ err: unknown; confirmationStatus?: string } | null>
  /** Block height per getBlockHeight call (default: far past every lastValidBlockHeight). */
  height?: () => number
}

function fakeConnection(script: Script) {
  const calls = {
    simulate: 0,
    send: 0,
    confirm: 0,
    blockhashes: 0,
    priorities: [] as number[],
    rawSigs: [] as Uint8Array[],
    asked: [] as string[][],
    order: [] as string[],
  }
  const conn: Record<string, unknown> = {
    async getLatestBlockhash() {
      calls.blockhashes++
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
    async sendRawTransaction(raw: Uint8Array) {
      calls.rawSigs.push(VersionedTransaction.deserialize(raw).signatures[0] as Uint8Array)
      const e = script.send?.[calls.send] ?? null
      calls.send++
      if (e) throw e
      return `sig${calls.send}`
    },
    async getBlockHeight() {
      calls.order.push('height')
      return script.height ? script.height() : 1_000
    },
    async confirmTransaction() {
      const r = script.confirm?.[calls.confirm++] ?? null
      if (r instanceof Error) throw r
      return { context: { slot: 1 }, value: { err: r?.err ?? null } }
    },
  }
  // Unless a test says otherwise the chain has never seen any signature.
  const statuses = script.statuses ?? ((sigs: string[]) => sigs.map(() => null))
  conn.getSignatureStatuses = async (sigs: string[]) => {
    calls.asked.push(sigs)
    calls.order.push('statuses')
    return { context: { slot: 1 }, value: statuses(sigs) }
  }
  return { conn: conn as unknown as Connection, calls }
}

const alerts = () => {
  const sent: string[] = []
  const texts: string[] = []
  return {
    sent,
    texts,
    alerter: {
      send: async (key: string, text: string) => {
        sent.push(key)
        texts.push(text)
      },
    },
  }
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function fromBase58(text: string): Buffer {
  let n = 0n
  for (const ch of text) n = n * 58n + BigInt(BASE58.indexOf(ch))
  const hex = n.toString(16)
  const body = n === 0n ? Buffer.alloc(0) : Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex')
  let zeros = 0
  while (text[zeros] === '1') zeros++
  return Buffer.concat([Buffer.alloc(zeros), body])
}

const spec = (extra: Record<string, unknown> = {}) => ({
  label: 'x',
  instructions: [ix],
  computeUnits: 10_000,
  priorityMicroLamports: 1_000,
  ...extra,
})

const captureLog = () => {
  const lines: string[] = []
  return { lines, log: pino({ level: 'trace' }, { write: (l: string) => void lines.push(l) }) }
}

const horagonIx = new TransactionInstruction({
  programId: HORAGON_PROGRAM_ID,
  keys: [],
  data: Buffer.alloc(0),
})

const sender = (conns: Connection[], extra: Partial<TxSenderOptions> = {}) =>
  new TxSender({
    connections: conns,
    payer,
    log,
    alerts: alerts().alerter,
    sleep: async () => {},
    ...extra,
  })

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
    const backoffs = sleeps.filter((ms) => ms !== 1_000)
    expect(backoffs.map((ms) => Math.floor(ms / 100) * 100)).toEqual([100, 200, 400, 800])
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

describe('TxSender: landed transactions', () => {
  it('does not resend when the confirmation was lost but the transaction landed', async () => {
    const { conn, calls } = fakeConnection({
      confirm: [new Error('block height exceeded')],
      statuses: () => [{ err: null, confirmationStatus: 'confirmed' }],
    })
    const r = await sender([conn]).send(spec())
    expect(calls.send).toBe(1)
    expect(r.alreadyDone).toBe(false)
    expect(r.attempts).toBe(1)
    const asked = calls.asked[0]?.[0] as string
    expect(r.signature).toBe(asked)
    // The signature we look up is the real base58 of the signed transaction.
    expect(fromBase58(asked).equals(Buffer.from(calls.rawSigs[0] as Uint8Array))).toBe(true)
  })

  it('does not resend when the send threw after the node accepted it', async () => {
    const { conn, calls } = fakeConnection({
      send: [new Error('socket hang up')],
      statuses: () => [{ err: null, confirmationStatus: 'finalized' }],
    })
    const r = await sender([conn]).send(spec())
    expect(calls.send).toBe(1)
    expect(r.signature).toBe(calls.asked[0]?.[0])
  })

  it('looks at every earlier signature and ignores one not yet processed', async () => {
    const { conn, calls } = fakeConnection({
      send: [new Error('timeout'), new Error('timeout'), null],
      statuses: (sigs) =>
        sigs.map((_, i) => (i === 1 ? { err: null, confirmationStatus: 'confirmed' } : null)),
    })
    const r = await sender([conn]).send(spec())
    expect(calls.send).toBe(2)
    expect(r.signature).toBe(calls.asked[calls.asked.length - 1]?.[1])
    expect(r.attempts).toBe(2)
  })

  it('waits for a processed attempt instead of rebuilding it', async () => {
    let n = 0
    const { conn, calls } = fakeConnection({
      send: [new Error('timeout')],
      statuses: () => [
        n++ === 0
          ? { err: null, confirmationStatus: 'processed' }
          : { err: null, confirmationStatus: 'confirmed' },
      ],
    })
    const sleeps: number[] = []
    const r = await sender([conn], { sleep: async (ms) => void sleeps.push(ms) }).send(spec())
    expect(calls.send).toBe(1)
    expect(calls.blockhashes).toBe(1)
    expect(new Set(calls.rawSigs.map((x) => Buffer.from(x).toString('hex'))).size).toBe(1)
    expect(r.signature).toBe(calls.asked[0]?.[0])
    expect(r.alreadyDone).toBe(false)
    expect(sleeps.filter((ms) => ms === 1_000)).toHaveLength(1)
  })

  it('rebuilds once an unseen attempt can no longer land, rebroadcasting meanwhile', async () => {
    const heights = [5, 5, 11]
    const { conn, calls } = fakeConnection({
      send: [new Error('502 Bad Gateway')],
      statuses: (sigs) => sigs.map(() => null),
      height: () => heights.shift() ?? 11,
    })
    const r = await sender([conn]).send(spec())
    expect(calls.blockhashes).toBe(2)
    const distinct = new Set(calls.rawSigs.map((x) => Buffer.from(x).toString('hex')))
    expect(distinct.size).toBe(2)
    expect(r.attempts).toBe(2)
    expect(calls.send).toBeGreaterThan(2)
    // The returned signature is the rebuilt attempt's (the fake names a send by its count).
    expect(r.signature).toBe(`sig${calls.send}`)
    expect(
      Buffer.from(calls.rawSigs[calls.rawSigs.length - 1] as Uint8Array).toString('hex'),
    ).not.toBe(Buffer.from(calls.rawSigs[0] as Uint8Array).toString('hex'))
  })

  it('does not rebuild on one clean null read when the next poll shows it confirmed', async () => {
    let n = 0
    const { conn, calls } = fakeConnection({
      send: [new Error('502 Bad Gateway')],
      statuses: () => [n++ === 0 ? null : { err: null, confirmationStatus: 'confirmed' }],
    })
    const r = await sender([conn]).send(spec())
    expect(calls.blockhashes).toBe(1)
    expect(r.signature).toBe(calls.asked[0]?.[0])
    expect(r.attempts).toBe(1)
  })

  it('rebuilds once after two clean null reads past the last valid height', async () => {
    const { conn, calls } = fakeConnection({ send: [new Error('502 Bad Gateway')] })
    const r = await sender([conn]).send(spec())
    expect(calls.blockhashes).toBe(2)
    expect(r.attempts).toBe(2)
    // Exactly two reads before the rebuild: one clean read is not enough, a third is not needed.
    expect(calls.asked).toHaveLength(2)
  })

  it('reads the height before the statuses and ignores a height not yet past', async () => {
    // Statuses say null, the height is still valid: the attempt may be in flight.
    const { conn, calls } = fakeConnection({
      send: [new Error('timeout')],
      height: () => 10,
    })
    const err = await sender([conn])
      .send(spec())
      .catch((x: Error) => x)
    expect(err).toBeInstanceOf(UnresolvedAttempt)
    expect(calls.blockhashes).toBe(1)
    // Every lookup reads the height first, then the statuses.
    expect(calls.order.length).toBeGreaterThan(2)
    for (let i = 0; i < calls.order.length; i += 2) {
      expect(calls.order.slice(i, i + 2)).toEqual(['height', 'statuses'])
    }
  })

  it('waits for the last attempt before giving up, and succeeds if it confirms', async () => {
    const e = new Error('timeout')
    let n = 0
    const { conn, calls } = fakeConnection({
      send: [e, e],
      statuses: (sigs) => {
        // The first attempt is dead (null). The second goes processed, then confirmed.
        if (sigs.length < 2) return [null]
        const call = n++
        return [
          null,
          call === 0
            ? { err: null, confirmationStatus: 'processed' }
            : { err: null, confirmationStatus: 'confirmed' },
        ]
      },
    })
    const r = await sender([conn], { maxAttempts: 2 }).send(spec())
    expect(r.signature).toBe(calls.asked[calls.asked.length - 1]?.[1])
    expect(r.attempts).toBe(2)
    expect(calls.send).toBe(2)
  })

  it('gives up with an unresolved error, not a rebuild, when the status stays processed', async () => {
    const { conn, calls } = fakeConnection({
      send: [new Error('timeout')],
      statuses: () => [{ err: null, confirmationStatus: 'processed' }],
    })
    const a = alerts()
    const sleeps: number[] = []
    const p = sender([conn], { alerts: a.alerter, sleep: async (ms) => void sleeps.push(ms) }).send(
      spec(),
    )
    await expect(p).rejects.toBeInstanceOf(UnresolvedAttempt)
    await expect(p).rejects.toThrow(/x: unresolved after 90 s, [A-Za-z0-9]+ may still land/)
    expect(calls.blockhashes).toBe(1)
    expect(new Set(calls.rawSigs.map((x) => Buffer.from(x).toString('hex'))).size).toBe(1)
    expect(a.sent).toEqual(['tx-unresolved:x'])
    expect(sleeps.filter((ms) => ms === 1_000)).toHaveLength(90)
  })

  it('treats failing status and height reads as unknown and gives up at the cap', async () => {
    const { conn, calls } = fakeConnection({
      send: [new Error('timeout')],
      statuses: () => {
        throw new Error('down')
      },
      height: () => {
        throw new Error('down')
      },
    })
    const a = alerts()
    const sleeps: number[] = []
    await expect(
      sender([conn], { alerts: a.alerter, sleep: async (ms) => void sleeps.push(ms) }).send(spec()),
    ).rejects.toBeInstanceOf(UnresolvedAttempt)
    expect(calls.blockhashes).toBe(1)
    expect(a.sent).toEqual(['tx-unresolved:x'])
    expect(sleeps.filter((ms) => ms === 1_000)).toHaveLength(90)
  })

  it('still returns alreadyDone at the cap when isDone says so', async () => {
    const { conn } = fakeConnection({
      send: [new Error('timeout')],
      statuses: () => [{ err: null, confirmationStatus: 'processed' }],
    })
    let polls = 0
    const r = await sender([conn]).send(spec({ isDone: async () => ++polls > 90 }))
    expect(r).toEqual({ signature: null, attempts: 1, alreadyDone: true })
  })

  it.each([
    ['ECONNREFUSED', 'connect'],
    ['ENOTFOUND', 'getaddrinfo'],
    ['EAI_AGAIN', 'getaddrinfo'],
  ])('does not wait when the node never got the request: %s', async (code, text) => {
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error(text), { code }),
    })
    const primary = fakeConnection({ send: [refused] })
    // If the refused attempt were still tracked, this backup would report it unseen and in flight.
    const backup = fakeConnection({ statuses: () => [null], height: () => 0 })
    const sleeps: number[] = []
    const s = sender([primary.conn, backup.conn], {
      sleep: async (ms) => void sleeps.push(ms),
      baseDelayMs: 100,
    })
    await s.send(spec())
    expect(primary.calls.asked).toHaveLength(0)
    expect(backup.calls.asked).toHaveLength(0)
    expect(sleeps).toHaveLength(1)
    expect(backup.calls.send).toBe(1)
  })

  it('does not treat an HTTP error body that names ECONNREFUSED as not sent', async () => {
    const { conn, calls } = fakeConnection({
      send: [new Error('502 Bad Gateway: upstream ECONNREFUSED')],
      height: () => 10,
    })
    await expect(sender([conn]).send(spec())).rejects.toBeInstanceOf(UnresolvedAttempt)
    expect(calls.blockhashes).toBe(1)
  })

  it('encodes base58 with leading zero bytes through the keeper encoder', () => {
    expect(base58(new Uint8Array(64))).toBe('1'.repeat(64))
    expect(base58(Uint8Array.from([0, 0, 1]))).toBe('112')
    expect(base58(Uint8Array.from([0, 1, 0]))).toBe('15R')
    expect(fromBase58('1'.repeat(64)).equals(Buffer.alloc(64))).toBe(true)
    expect(fromBase58('112').equals(Buffer.from([0, 0, 1]))).toBe(true)
  })

  it('finds a success before it throws on an earlier failed signature', async () => {
    const { conn } = fakeConnection({
      send: [new Error('timeout'), new Error('timeout')],
      statuses: (sigs) =>
        sigs.length < 2
          ? [null]
          : [
              { err: { InstructionError: [2, { Custom: 6005 }] } },
              { err: null, confirmationStatus: 'confirmed' },
            ],
    })
    const r = await sender([conn], { maxAttempts: 2 }).send(spec())
    expect(r.signature).not.toBeNull()
    expect(r.attempts).toBe(2)
  })

  it('does not rebuild on a failed status read, even with the height past, and logs it safely', async () => {
    const { lines, log: capture } = captureLog()
    const { conn, calls } = fakeConnection({
      send: [new Error('timeout')],
      statuses: () => {
        throw new Error('lookup failed https://rpc.example.com/v2/SECRETKEY?k=SECRETKEY')
      },
    })
    const a = alerts()
    const err = await sender([conn], { log: capture, alerts: a.alerter })
      .send(spec())
      .catch((x: Error) => x)
    expect(err).toBeInstanceOf(UnresolvedAttempt)
    expect(calls.blockhashes).toBe(1)
    expect(new Set(calls.rawSigs.map((x) => Buffer.from(x).toString('hex'))).size).toBe(1)
    expect(a.sent).toEqual(['tx-unresolved:x'])
    expect(lines.join(',')).toContain('signature status lookup failed')
    expect(lines.join(',')).not.toContain('SECRETKEY')
  })

  it('reports a transaction that landed with a program error, with its code', async () => {
    const { conn, calls } = fakeConnection({
      send: [new Error('timeout')],
      statuses: () => [{ err: { InstructionError: [2, { Custom: 6005 }] } }],
    })
    const p = sender([conn]).send(spec({ instructions: [horagonIx] }))
    await expect(p).rejects.toBeInstanceOf(ProgramFailure)
    await expect(p).rejects.toMatchObject({
      program: 'horagon',
      code: 6005,
      errorName: 'BadStatus',
    })
    expect(calls.send).toBe(1)
  })

  it('skips a landed status whose error is not an instruction error', async () => {
    const { conn, calls } = fakeConnection({
      send: [new Error('timeout')],
      statuses: () => [{ err: 'BlockhashNotFound' }],
    })
    const r = await sender([conn]).send(spec())
    expect(r.attempts).toBe(2)
    expect(calls.send).toBe(2)
  })

  it('parses a confirmation-time program error into a code', async () => {
    const { conn } = fakeConnection({
      confirm: [{ err: { InstructionError: [2, { Custom: 6005 }] } }],
    })
    const p = sender([conn]).send(spec({ instructions: [horagonIx] }))
    await expect(p).rejects.toMatchObject({
      program: 'horagon',
      code: 6005,
      errorName: 'BadStatus',
    })
  })

  it('names a builtin instruction error when there is no custom code', async () => {
    const { conn } = fakeConnection({
      confirm: [{ err: { InstructionError: [2, 'InvalidAccountData'] } }],
    })
    await expect(sender([conn]).send(spec())).rejects.toMatchObject({
      program: 'runtime',
      code: null,
      errorName: 'InvalidAccountData',
    })
  })

  it('treats a program failure on a retry as done when isDone says so', async () => {
    const { conn, calls } = fakeConnection({
      send: [new Error('timeout')],
      simulate: [{ err: null }, { err: { InstructionError: [2, { Custom: 6005 }] } }],
    })
    const r = await sender([conn]).send(spec({ isDone: async () => calls.simulate >= 2 }))
    expect(r).toEqual({ signature: null, attempts: 1, alreadyDone: true })
    expect(calls.send).toBe(1)
  })

  it('rethrows a program failure on a retry when nothing landed', async () => {
    const { conn } = fakeConnection({
      send: [new Error('timeout')],
      simulate: [{ err: null }, { err: { InstructionError: [2, { Custom: 6005 }] } }],
    })
    await expect(sender([conn]).send(spec({ isDone: async () => false }))).rejects.toBeInstanceOf(
      ProgramFailure,
    )
  })

  it('checks isDone once more before giving up', async () => {
    const e = new Error('timeout')
    const { conn, calls } = fakeConnection({ send: [e, e, e, e, e] })
    // No before the fifth send has failed; yes only in the check after the loop.
    const r = await sender([conn]).send(spec({ isDone: async () => calls.send >= 5 }))
    expect(r).toEqual({ signature: null, attempts: 5, alreadyDone: true })
  })

  it('logs an isDone failure without the URL and carries on', async () => {
    const { lines, log: capture } = captureLog()
    const { conn } = fakeConnection({ send: [new Error('timeout')] })
    const r = await sender([conn], { log: capture }).send(
      spec({
        isDone: async () => {
          throw new Error('rpc down https://rpc.example.com/v2/SECRETKEY?k=SECRETKEY')
        },
      }),
    )
    expect(r.attempts).toBe(2)
    expect(lines.join(',')).toContain('isDone failed')
    expect(lines.join(',')).not.toContain('SECRETKEY')
  })
})

describe('TxSender: unresolved attempts', () => {
  const refused = () =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('c'), { code: 'ECONNREFUSED' }),
    })

  it('delivers both the 4th-failure alert and the unresolved alert, under different keys', async () => {
    const { conn } = fakeConnection({
      send: [refused(), refused(), refused(), refused()],
      confirm: [new Error('timeout')],
      statuses: () => [{ err: null, confirmationStatus: 'processed' }],
    })
    const a = alerts()
    await expect(sender([conn], { alerts: a.alerter }).send(spec())).rejects.toBeInstanceOf(
      UnresolvedAttempt,
    )
    expect(a.sent).toEqual(['tx:x', 'tx-unresolved:x'])
    expect(a.texts[1]).toMatch(/may still land/)
  })

  it('caps on the give-up path with one unresolved alert', async () => {
    const { conn } = fakeConnection({
      send: [new Error('timeout')],
      statuses: () => [{ err: null, confirmationStatus: 'processed' }],
    })
    const a = alerts()
    await expect(
      sender([conn], { alerts: a.alerter, maxAttempts: 1 }).send(spec()),
    ).rejects.toBeInstanceOf(UnresolvedAttempt)
    expect(a.sent.filter((k) => k.startsWith('tx-unresolved:'))).toEqual(['tx-unresolved:x'])
  })

  it('caps on the program-failure path with one unresolved alert', async () => {
    let reads = 0
    const { conn } = fakeConnection({
      send: [new Error('timeout')],
      simulate: [{ err: null }, { err: { InstructionError: [2, { Custom: 6005 }] } }],
      // Two clean null reads let attempt 2 start; afterwards the first attempt looks processed.
      statuses: () => [reads++ < 2 ? null : { err: null, confirmationStatus: 'processed' }],
    })
    const a = alerts()
    await expect(sender([conn], { alerts: a.alerter }).send(spec())).rejects.toBeInstanceOf(
      UnresolvedAttempt,
    )
    expect(a.sent.filter((k) => k.startsWith('tx-unresolved:'))).toEqual(['tx-unresolved:x'])
  })

  it('reports an attempt that landed with an instruction error as that failure, never as unresolved', async () => {
    let reads = 0
    const { conn } = fakeConnection({
      send: [new Error('timeout')],
      confirm: [{ err: { InstructionError: [2, { Custom: 6005 }] } }],
      statuses: () => {
        if (reads++ < 2) return [null]
        throw new Error('down')
      },
    })
    const a = alerts()
    const sleeps: number[] = []
    const p = sender([conn], {
      alerts: a.alerter,
      sleep: async (ms) => void sleeps.push(ms),
    }).send(spec({ instructions: [horagonIx] }))
    await expect(p).rejects.toBeInstanceOf(ProgramFailure)
    await expect(p).rejects.toMatchObject({ program: 'horagon', code: 6005 })
    expect(a.sent.filter((k) => k.startsWith('tx-unresolved:'))).toEqual([])
    expect(sleeps.filter((ms) => ms === 1_000)).toHaveLength(1)
  })
})

describe('TxSender: retries and failover', () => {
  it('caps the priority fee', async () => {
    const e = new Error('timeout')
    const { conn, calls } = fakeConnection({ send: [e, e, e, e, null] })
    await sender([conn], { maxPriorityMicroLamports: 3_000 }).send(spec())
    expect(calls.priorities).toEqual([1_000, 2_000, 3_000, 3_000, 3_000])
  })

  it('retries a simulation error that is not a program error', async () => {
    const { conn, calls } = fakeConnection({ simulate: [{ err: 'AccountNotFound' }] })
    const r = await sender([conn]).send(spec())
    expect(r.attempts).toBe(2)
    expect(calls.simulate).toBe(2)
  })

  it('retries a confirmation error that is not a program error', async () => {
    const { conn } = fakeConnection({ confirm: [{ err: 'BlockhashNotFound' }] })
    const r = await sender([conn]).send(spec())
    expect(r.attempts).toBe(2)
  })

  it('stays on the only connection after a 429', async () => {
    const { conn, calls } = fakeConnection({ send: [new Error('429 Too Many Requests')] })
    const s = sender([conn])
    const r = await s.send(spec())
    expect(r.attempts).toBe(2)
    expect(calls.send).toBe(2)
    expect(s.connection).toBe(conn)
  })

  it.each([
    'fetch failed',
    'connect ECONNREFUSED 127.0.0.1:8899',
    'read ECONNRESET',
    'Request timed out',
    'Server responded with 503 Service Unavailable',
    'HTTP error 502',
  ])('moves to the backup RPC on a network error: %s', async (message) => {
    const primary = fakeConnection({ send: [new Error(message)] })
    const backup = fakeConnection({})
    const s = sender([primary.conn, backup.conn])
    await s.send(spec())
    expect(backup.calls.send).toBe(1)
    expect(s.connection).toBe(backup.conn)
  })

  it('stays on the primary RPC for an error that is not about the connection', async () => {
    const primary = fakeConnection({ send: [new Error('blockhash not found')] })
    const backup = fakeConnection({})
    const s = sender([primary.conn, backup.conn])
    await s.send(spec())
    expect(primary.calls.send).toBe(2)
    expect(backup.calls.send).toBe(0)
  })

  it('stays on the primary RPC for a program failure', async () => {
    const primary = fakeConnection({
      simulate: [{ err: { InstructionError: [2, { Custom: 6005 }] } }],
    })
    const backup = fakeConnection({})
    const s = sender([primary.conn, backup.conn])
    await expect(s.send(spec())).rejects.toBeInstanceOf(ProgramFailure)
    expect(s.connection).toBe(primary.conn)
  })

  it('alerts on the last attempt when fewer than 4 are allowed, with the reason', async () => {
    const e = new Error('timeout')
    const { conn } = fakeConnection({ send: [e, e] })
    const a = alerts()
    await expect(
      sender([conn], { maxAttempts: 2, alerts: a.alerter }).send(spec()),
    ).rejects.toThrow(/gave up after 2 attempts/)
    expect(a.sent).toEqual(['tx:x'])
    expect(a.texts[0]).toContain('failed 2 times (timeout)')
    expect(a.texts[0]).toContain('giving up')
  })

  it('says how many attempts are left in the alert', async () => {
    const e = new Error('timeout')
    const { conn } = fakeConnection({ send: [e, e, e, e, null] })
    const a = alerts()
    await sender([conn], { alerts: a.alerter }).send(spec())
    expect(a.texts[0]).toContain('failed 4 times (timeout); 1 attempt left')
  })

  it('refuses to start without a connection', () => {
    expect(() => sender([])).toThrow(/at least one connection/)
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

  it('keeps different keys apart', async () => {
    const bodies: string[] = []
    const alerter = telegramAlerter({
      token: 'T',
      chatId: '42',
      log,
      now: () => 1_000,
      fetchImpl: (async (_url: string, init: { body: string }) => {
        bodies.push(init.body)
        return new Response('{}', { status: 200 })
      }) as unknown as typeof fetch,
    })
    await alerter.send('a', 'one')
    await alerter.send('b', 'two')
    expect(bodies).toHaveLength(2)
  })

  it.each([
    ['a network error', async () => Promise.reject(new Error('fetch failed'))],
    ['a non-2xx answer', async () => new Response('no', { status: 500 })],
  ])('sends again after 60 s, not before, when delivery failed with %s', async (_n, reply) => {
    let t = 1_000
    let calls = 0
    const alerter = telegramAlerter({
      token: 'T',
      chatId: '42',
      log,
      now: () => t,
      fetchImpl: (async () => {
        calls++
        return reply()
      }) as unknown as typeof fetch,
    })
    await alerter.send('k', 'x')
    t += 59
    await alerter.send('k', 'x')
    expect(calls).toBe(1)
    t += 1
    await alerter.send('k', 'x')
    expect(calls).toBe(2)
    t += 59
    await alerter.send('k', 'x')
    expect(calls).toBe(2)
  })

  it('does not retry early after a failure when the window is shorter than 60 s', async () => {
    let t = 1_000
    let calls = 0
    const alerter = telegramAlerter({
      token: 'T',
      chatId: '42',
      log,
      dedupeSecs: 10,
      now: () => t,
      fetchImpl: (async () => {
        calls++
        throw new Error('down')
      }) as unknown as typeof fetch,
    })
    await alerter.send('k', 'x')
    t += 9
    await alerter.send('k', 'x')
    expect(calls).toBe(1)
    t += 1
    await alerter.send('k', 'x')
    expect(calls).toBe(2)
  })
})

describe('logAlerter', () => {
  it('only logs the alert', async () => {
    const { lines, log: capture } = captureLog()
    await logAlerter(capture).send('k', 'Halted')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ key: 'k', alert: 'Halted' })
  })
})
