// Small pieces of the keeper's loops (`main.ts`), kept apart so they are unit tested: one step
// that fails on its own, the steps of a tick round and of an index round in order and the round
// that stops between two steps, a gate for periodic steps, the periodic loop each of them runs
// on, and the failure streaks that page when the tick or the indexer keeps failing.
import { errorSummary } from '@horagon/sdk'
import type { Logger } from 'pino'
import type { StallGuard } from './stall'

export type StepResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

/** Runs one step of a round. A failure is logged (redacted) and returned, never thrown. */
export async function runStep<T>(
  log: Logger,
  name: string,
  fn: () => Promise<T>,
  guard?: Pick<StallGuard, 'step'>,
): Promise<StepResult<T>> {
  guard?.step(name)
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    log.error({ step: name, error: errorSummary(error).message }, 'step failed')
    return { ok: false, error }
  } finally {
    guard?.step(null)
  }
}

export type RoundStep = 'tick' | 'schedule' | 'treasury' | 'archive'

/**
 * The steps of one tick round, in order. The tick (halts, drafts, settlement) comes first, so a
 * halt due in this round never waits on the hourly work. Then, behind one hourly gate: the
 * schedule sets the featured flags of the next 36 h before the treasury counts their seeds, then
 * the ESPN archive retention (`archive`: with an archive directory). The indexer and the ATA
 * watch run on a loop of their own (`indexSteps`), so a slow or hung read there never holds a
 * tick.
 */
export function roundSteps(o: { hourly: boolean; archive: boolean }): RoundStep[] {
  return [
    'tick',
    ...(o.hourly ? (['schedule', 'treasury'] as const) : []),
    ...(o.hourly && o.archive ? (['archive'] as const) : []),
  ]
}

export type IndexStep = 'index' | 'ata-watch' | 'sponsor-marks'

/**
 * The steps of one index round: the indexer, then the sponsored-ATA watch and the sponsor budget
 * marks (`sponsor-marks.ts`, database only) when each is due.
 */
export function indexSteps(o: { ataWatch: boolean; sponsorMarks?: boolean }): IndexStep[] {
  return [
    'index',
    ...(o.ataWatch ? (['ata-watch'] as const) : []),
    ...(o.sponsorMarks ? (['sponsor-marks'] as const) : []),
  ]
}

/**
 * Runs `round` every `periodMs` (start to start; at once when a round took longer), never two
 * rounds at once, until `stopping()`: a stop ends the loop after the round in progress, and
 * `wake()` cuts the wait between rounds short. `round` handles its own failures (`runStep`).
 * Each of the keeper's loops (tick, index) is one; they run side by side.
 */
export class PeriodicLoop {
  /** Rounds finished. */
  rounds = 0
  /** When (ms, the loop's clock) the last round ended; null before the first. */
  lastRoundAt: number | null = null
  private startedAt: number | null = null
  /** When (ms) the round in progress last made progress (`progress()`). */
  private progressAt = Number.NEGATIVE_INFINITY
  private wakeUp: (() => void) | undefined

  constructor(
    private readonly opts: {
      periodMs: number
      round: () => Promise<void>
      stopping: () => boolean
      /** Wall clock in ms; defaults to Date.now. */
      clock?: () => number
    },
  ) {}

  async run(): Promise<void> {
    const clock = this.opts.clock ?? Date.now
    while (!this.opts.stopping()) {
      const started = clock()
      this.startedAt = started
      try {
        await this.opts.round()
      } finally {
        this.startedAt = null
      }
      this.rounds++
      this.lastRoundAt = clock()
      if (this.opts.stopping()) break
      // Never longer than one period, even after the clock steps back.
      const wait = Math.min(
        this.opts.periodMs,
        Math.max(0, this.opts.periodMs - (clock() - started)),
      )
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait)
        this.wakeUp = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.wakeUp = undefined
    }
  }

  /** Ends the wait between two rounds now (a stop). */
  wake(): void {
    this.wakeUp?.()
  }

  /** How long (ms) the round in progress has run; null between rounds. */
  busyMs(): number | null {
    return this.startedAt === null ? null : (this.opts.clock ?? Date.now)() - this.startedAt
  }

  /** The round in progress did something (an RPC read answered or failed). */
  progress(): void {
    this.progressAt = (this.opts.clock ?? Date.now)()
  }

  /**
   * How long (ms) the round in progress has gone without progress: since it started or since its
   * last `progress()`, whichever is later; null between rounds. A long round that keeps reading
   * is not stalled; one waiting on a lost database response is.
   */
  stalledMs(): number | null {
    if (this.startedAt === null) return null
    return (this.opts.clock ?? Date.now)() - Math.max(this.startedAt, this.progressAt)
  }
}

/**
 * Runs the steps in order, checking `stopping` before each: a stop (SIGTERM) ends the round
 * after the step in progress. `run` handles its own failures (`runStep`).
 */
export async function runRound<S extends string>(
  steps: readonly S[],
  run: (step: S) => Promise<void>,
  stopping: () => boolean,
): Promise<{ ran: S[]; stopped: boolean }> {
  const ran: S[] = []
  for (const step of steps) {
    if (stopping()) return { ran, stopped: true }
    await run(step)
    ran.push(step)
  }
  return { ran, stopped: false }
}

/** True on the first call, then once `periodSecs` have passed since the last true. */
export function dueEvery(periodSecs: number): (nowSecs: number) => boolean {
  let last: number | null = null
  return (t) => {
    if (last !== null && t - last < periodSecs) return false
    last = t
    return true
  }
}

/** 12 rounds of 5 s: about a minute of a step failing every time. */
export const FAILING_ALERT_AFTER = 12

/**
 * Consecutive failures of one step. From the threshold on, every failure returns the
 * `<name>-failing` alert (the alerter's window drops the repeats); a success resets the count.
 */
export class FailureStreak {
  private n = 0

  constructor(
    readonly name: string,
    readonly alertAfter = FAILING_ALERT_AFTER,
  ) {}

  get count(): number {
    return this.n
  }

  record(result: { ok: true } | { ok: false; error: unknown }): {
    key: string
    text: string
  } | null {
    if (result.ok) {
      this.n = 0
      return null
    }
    this.n++
    if (this.n < this.alertAfter) return null
    return {
      key: `${this.name}-failing`,
      text: `The keeper's ${this.name} step failed ${this.n} rounds in a row: ${errorSummary(result.error).message}`,
    }
  }
}
