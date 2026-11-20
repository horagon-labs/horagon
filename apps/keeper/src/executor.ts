// Sends the keeper's transactions (spec 12): simulate, send, confirm; on a transient failure
// retry up to 5 times with exponential backoff and a rising priority fee, moving to the backup
// RPC on a 429. A program error is deterministic and is never retried. Before every retry the
// caller's `isDone` re-reads chain state, so a transaction that landed but whose confirmation
// was lost is not sent twice.
import { errorSummary, failedProgramError } from '@horagon/sdk'
import {
  ComputeBudgetProgram,
  type Connection,
  type Keypair,
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

const isRateLimit = (err: unknown) =>
  /\b429\b|Too Many Requests/i.test(String((err as Error)?.message ?? err))

function instructionError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'InstructionError' in err
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
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if (attempt > 1 && spec.isDone && (await spec.isDone().catch(() => false))) {
        return { signature: null, attempts: attempt - 1, alreadyDone: true }
      }
      const priority = Math.min(this.maxPriority, spec.priorityMicroLamports * 2 ** (attempt - 1))
      try {
        const signature = await this.attempt(spec, priority)
        this.opts.log.info({ label: spec.label, sig: signature, attempt }, 'tx confirmed')
        return { signature, attempts: attempt, alreadyDone: false }
      } catch (err) {
        if (err instanceof ProgramFailure) throw err
        lastError = err
        if (isRateLimit(err) && this.opts.connections.length > 1) {
          this.active = (this.active + 1) % this.opts.connections.length
          this.opts.log.warn({ label: spec.label, rpc: this.active }, 'rate limited, switching RPC')
        }
        this.opts.log.warn(
          { label: spec.label, attempt, error: errorSummary(err).message },
          'tx attempt failed',
        )
        if (attempt === 4) {
          await this.opts.alerts.send(
            `tx:${spec.label}`,
            `Transaction "${spec.label}" failed 4 times; retrying once more`,
          )
        }
        if (attempt < this.maxAttempts) {
          const jitter = Math.floor(Math.random() * this.baseDelayMs)
          await this.sleep(this.baseDelayMs * 2 ** (attempt - 1) + jitter)
        }
      }
    }
    if (spec.isDone && (await spec.isDone().catch(() => false))) {
      return { signature: null, attempts: this.maxAttempts, alreadyDone: true }
    }
    // The last error may carry an RPC URL with a key: redact it like every other log line.
    throw new Error(
      `${spec.label}: gave up after ${this.maxAttempts} attempts: ${errorSummary(lastError).message}`,
    )
  }

  private async attempt(spec: SendSpec, priority: number): Promise<string> {
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
    const signature = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 0,
    })
    const res = await conn.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    )
    if (res.value.err) {
      if (instructionError(res.value.err)) {
        throw new ProgramFailure(spec.label, 'runtime', null, JSON.stringify(res.value.err), [])
      }
      throw new Error(`transaction failed: ${JSON.stringify(res.value.err)}`)
    }
    return signature
  }
}
