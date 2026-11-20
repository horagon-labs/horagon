// Sends the keeper's transactions (spec 12): simulate, send, confirm; on a transient failure
// retry up to 5 times with exponential backoff and a rising priority fee, moving to the backup
// RPC on a 429 or a network error. A program error is deterministic and is never retried.
//
// When can a transaction be sent twice? Never because of a retry we start. A retry rebuilds with
// a new blockhash, hence a new signature, so before it (and before giving up) the newest sent
// attempt must be unable to land: its status is looked up, and while it is `processed`, or
// unseen with its blockhash still valid (or the RPC cannot say), we wait, polling once a second
// and re-broadcasting the same bytes (same signature, so it cannot land twice), for at most
// 90 s. We rebuild only once the block height passed `lastValidBlockHeight`, or when the send
// error proves the node never got the request (ECONNREFUSED, ENOTFOUND, EAI_AGAIN). Landed
// attempts are returned, and `isDone` is asked as well when given. Left open: an RPC that
// cannot answer for the whole 90 s wait.
import {
  errorSummary,
  failedProgramError,
  HORAGON_PROGRAM_ID,
  horagonErrorName,
  PM_AMM_ERROR_NAMES,
  PM_AMM_PROGRAM_ID,
} from '@horagon/sdk'
import {
  ComputeBudgetProgram,
  type Connection,
  type Keypair,
  type SignatureStatus,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import type { Logger } from 'pino'
import type { Alerter } from './alerts'

export interface SendSpec {
  /** Short name for logs and alerts, e.g. "halt nba-401910007". */
  label: string
  instructions: TransactionInstruction[]
  computeUnits: number
  /** Micro-lamports per CU for the first attempt; doubled on each retry, capped. */
  priorityMicroLamports: number
  /** Signers besides the payer. */
  signers?: Keypair[]
  /** True once the effect is on chain (checked before each retry). */
  isDone?: () => Promise<boolean>
}

export interface SendResult {
  signature: string | null
  attempts: number
  /** An earlier attempt (or another process) had already done it. */
  alreadyDone: boolean
}

/** The program rejected the transaction; retrying cannot help. */
export class ProgramFailure extends Error {
  constructor(
    readonly label: string,
    readonly program: string,
    readonly code: number | null,
    readonly errorName: string | undefined,
    readonly logs: readonly string[],
  ) {
    super(`${label}: ${program} error ${errorName ?? code ?? 'unknown'}`)
  }
}

export interface TxSenderOptions {
  /** Primary first, then backups. */
  connections: Connection[]
  payer: Keypair
  log: Logger
  alerts: Alerter
  maxAttempts?: number
  baseDelayMs?: number
  maxPriorityMicroLamports?: number
  sleep?: (ms: number) => Promise<void>
}

const messageOf = (err: unknown) => String((err as Error)?.message ?? err)

const isRateLimit = (err: unknown) => /\b429\b|Too Many Requests/i.test(messageOf(err))

/** Network-level trouble or an HTTP 5xx: another RPC may answer where this one does not. */
const NETWORK_ERROR =
  /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|time(?:d)?[ -]?out|(?:HTTP|status|error)\D{0,12}5\d\d\b|\b5\d\d (?:Internal|Bad Gateway|Service|Gateway)/i
const isNetworkError = (err: unknown) => NETWORK_ERROR.test(messageOf(err))

/** The send failed before the node could have received the request: nothing is in flight. */
const NOT_SENT = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i

/** An attempt that was sent (or may have been): what we need to look it up or rebroadcast it. */
interface Sent {
  signature: string
  lastValidBlockHeight: number
  raw: Uint8Array
}

const POLL_MS = 1_000
const MAX_WAIT_MS = 90_000

function instructionError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'InstructionError' in err
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Base58 of a signature, the form RPC methods take. */
function base58(bytes: Uint8Array): string {
  const digits: number[] = []
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i++) {
      carry += (digits[i] as number) << 8
      digits[i] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  let out = ''
  for (const byte of bytes) {
    if (byte !== 0) break
    out += '1'
  }
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58[digits[i] as number]
  return out
}

/**
 * Turns an on-chain `{ InstructionError: [index, detail] }` into a ProgramFailure with the
 * numeric code. The two compute-budget instructions come first. Without logs the program is
 * the one that owns the failing top-level instruction: a pm-AMM error raised through a CPI is
 * then named by the horagon table, which is why simulation (with logs) is the better source.
 */
function chainProgramFailure(spec: SendSpec, err: unknown): ProgramFailure {
  const [index, detail] = (err as { InstructionError: [number, unknown] }).InstructionError
  const custom =
    typeof detail === 'object' &&
    detail !== null &&
    typeof (detail as { Custom?: unknown }).Custom === 'number'
      ? (detail as { Custom: number }).Custom
      : null
  const programId = spec.instructions[index - 2]?.programId
  let program = 'runtime'
  let name: string | undefined
  if (custom !== null && programId?.equals(HORAGON_PROGRAM_ID)) {
    program = 'horagon'
    name = horagonErrorName(custom)
  } else if (custom !== null && programId?.equals(PM_AMM_PROGRAM_ID)) {
    program = 'pm-amm'
    name = PM_AMM_ERROR_NAMES[custom]
  } else if (custom === null) {
    name = typeof detail === 'string' ? detail : JSON.stringify(detail)
  }
  return new ProgramFailure(spec.label, program, custom, name, [])
}

export class TxSender {
  private active = 0
  private readonly maxAttempts: number
  private readonly baseDelayMs: number
  private readonly maxPriority: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly opts: TxSenderOptions) {
    if (opts.connections.length === 0) throw new Error('TxSender needs at least one connection')
    this.maxAttempts = opts.maxAttempts ?? 5
    this.baseDelayMs = opts.baseDelayMs ?? 500
    this.maxPriority = opts.maxPriorityMicroLamports ?? 2_000_000
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  get connection(): Connection {
    return this.opts.connections[this.active] as Connection
  }

  async send(spec: SendSpec): Promise<SendResult> {
    let lastError: unknown
    const sent: Sent[] = []
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (attempt > 1) {
        const done = await this.alreadyLanded(spec, sent, attempt - 1)
        if (done) return done
      }
      const priority = Math.min(this.maxPriority, spec.priorityMicroLamports * 2 ** (attempt - 1))
      try {
        const signature = await this.attempt(spec, priority, sent)
        this.opts.log.info({ label: spec.label, sig: signature, attempt }, 'tx confirmed')
        return { signature, attempts: attempt, alreadyDone: false }
      } catch (err) {
        if (err instanceof ProgramFailure) {
          // An earlier attempt may have done the work this one now fails on.
          const done = attempt > 1 ? await this.alreadyLanded(spec, sent, attempt - 1) : null
          if (done) return done
          throw err
        }
        lastError = err
        if ((isRateLimit(err) || isNetworkError(err)) && this.opts.connections.length > 1) {
          this.active = (this.active + 1) % this.opts.connections.length
          this.opts.log.warn({ label: spec.label, rpc: this.active }, 'RPC trouble, switching RPC')
        }
        const summary = errorSummary(err).message
        this.opts.log.warn({ label: spec.label, attempt, error: summary }, 'tx attempt failed')
        if (attempt === Math.min(4, this.maxAttempts)) {
          const left = this.maxAttempts - attempt
          await this.opts.alerts.send(
            `tx:${spec.label}`,
            `Transaction "${spec.label}" failed ${attempt} times (${summary}); ${
              left > 0 ? `${left} attempt${left === 1 ? '' : 's'} left` : 'giving up'
            }`,
          )
        }
        if (attempt < this.maxAttempts) {
          const jitter = Math.floor(Math.random() * this.baseDelayMs)
          await this.sleep(this.baseDelayMs * 2 ** (attempt - 1) + jitter)
        }
      }
    }
    const done = await this.alreadyLanded(spec, sent, this.maxAttempts)
    if (done) return done
    // The last error may carry an RPC URL with a key: redact it like every other log line.
    throw new Error(
      `${spec.label}: gave up after ${this.maxAttempts} attempts: ${errorSummary(lastError).message}`,
    )
  }

  /**
   * Did an earlier attempt land, or does the caller say the effect is on chain? Returns null
   * only when it is safe to build a new transaction: nothing was sent, or the newest sent
   * attempt can no longer land. While it still can, waits for it (see the header). Throws
   * ProgramFailure when an attempt landed with a program error.
   */
  private async alreadyLanded(
    spec: SendSpec,
    sent: Sent[],
    attempts: number,
  ): Promise<SendResult | null> {
    for (let waited = 0; ; waited += POLL_MS) {
      const state = await this.lookup(spec, sent)
      if (state.landed) return { signature: state.landed, attempts, alreadyDone: false }
      if (spec.isDone) {
        try {
          if (await spec.isDone()) return { signature: null, attempts, alreadyDone: true }
        } catch (err) {
          this.opts.log.warn(
            { label: spec.label, error: errorSummary(err).message },
            'isDone failed',
          )
        }
      }
      if (!state.inflight || waited >= MAX_WAIT_MS) return null
      const newest = sent[sent.length - 1] as Sent
      if (!state.processed) await this.rebroadcast(spec, newest)
      await this.sleep(POLL_MS)
    }
  }

  /** Looks the sent attempts up on chain. */
  private async lookup(
    spec: SendSpec,
    sent: Sent[],
  ): Promise<{ landed?: string; inflight: boolean; processed: boolean }> {
    const newest = sent[sent.length - 1]
    if (!newest) return { inflight: false, processed: false }
    let statuses: Array<SignatureStatus | null> | undefined
    try {
      const res = await this.connection.getSignatureStatuses(
        sent.map((s) => s.signature),
        { searchTransactionHistory: true },
      )
      statuses = res.value
    } catch (err) {
      this.opts.log.warn(
        { label: spec.label, error: errorSummary(err).message },
        'signature status lookup failed',
      )
    }
    if (statuses) {
      // A success anywhere wins; only then do errors count.
      for (const [i, status] of statuses.entries()) {
        if (
          status &&
          !status.err &&
          (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
        ) {
          return { landed: (sent[i] as Sent).signature, inflight: false, processed: false }
        }
      }
      for (const status of statuses) {
        if (status?.err && instructionError(status.err)) throw chainProgramFailure(spec, status.err)
      }
      const last = statuses[statuses.length - 1]
      if (last?.err) return { inflight: false, processed: false }
      if (last) return { inflight: true, processed: true }
    }
    // Unseen, or the lookup failed: only the block height says whether it can still land.
    try {
      const height = await this.connection.getBlockHeight('confirmed')
      return { inflight: height <= newest.lastValidBlockHeight, processed: false }
    } catch (err) {
      this.opts.log.warn(
        { label: spec.label, error: errorSummary(err).message },
        'block height lookup failed',
      )
      return { inflight: true, processed: false }
    }
  }

  /** Same bytes, same signature: cannot land twice. */
  private async rebroadcast(spec: SendSpec, sent: Sent): Promise<void> {
    try {
      await this.connection.sendRawTransaction(sent.raw, { skipPreflight: true, maxRetries: 0 })
    } catch (err) {
      this.opts.log.warn(
        { label: spec.label, error: errorSummary(err).message },
        'rebroadcast failed',
      )
    }
  }

  private async attempt(spec: SendSpec, priority: number, sent: Sent[]): Promise<string> {
    const conn = this.connection
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
    const message = new TransactionMessage({
      payerKey: this.opts.payer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: spec.computeUnits }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
        ...spec.instructions,
      ],
    }).compileToV0Message()
    const tx = new VersionedTransaction(message)
    tx.sign([this.opts.payer, ...(spec.signers ?? [])])

    const sim = await conn.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' })
    if (sim.value.err) {
      const logs = sim.value.logs ?? []
      if (instructionError(sim.value.err)) {
        const failed = failedProgramError(logs)
        throw new ProgramFailure(
          spec.label,
          failed?.program ?? 'runtime',
          failed?.code ?? null,
          failed?.name,
          logs,
        )
      }
      throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`)
    }
    // Known before the send, so a send or confirmation that throws can still be looked up.
    const raw = tx.serialize()
    const entry = { signature: base58(tx.signatures[0] as Uint8Array), lastValidBlockHeight, raw }
    sent.push(entry)
    let signature: string
    try {
      signature = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
    } catch (err) {
      // The node never got it: nothing can be in flight.
      if (NOT_SENT.test(messageOf(err))) sent.splice(sent.indexOf(entry), 1)
      throw err
    }
    const res = await conn.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    )
    if (res.value.err) {
      if (instructionError(res.value.err)) throw chainProgramFailure(spec, res.value.err)
      throw new Error(`transaction failed: ${JSON.stringify(res.value.err)}`)
    }
    return signature
  }
}
