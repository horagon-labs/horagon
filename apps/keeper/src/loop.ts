// Small pieces of the keeper's main loop (`main.ts`), kept apart so they are unit tested: one
// step that fails on its own, the steps of a round in order and the round that stops between
// two steps, a gate for periodic steps, and the failure streaks that page when the tick or the
// indexer keeps failing.
import { errorSummary } from '@horagon/sdk'
import type { Logger } from 'pino'

export type StepResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

/** Runs one step of a round. A failure is logged (redacted) and returned, never thrown. */
export async function runStep<T>(
  log: Logger,
  name: string,
  fn: () => Promise<T>,
): Promise<StepResult<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    log.error({ step: name, error: errorSummary(error).message }, 'step failed')
    return { ok: false, error }
  }
}

export type RoundStep = 'tick' | 'index' | 'schedule' | 'treasury' | 'archive' | 'ata-watch'

/**
 * The steps of one round, in order. The tick (halts, drafts, settlement) and the indexer come
 * first, so a halt due in this round never waits on the hourly work. Then, behind one hourly
 * gate: the schedule sets the featured flags of the next 36 h before the treasury counts their
 * seeds, then the ESPN archive retention (`archive`: with an archive directory). Last, the
 * sponsored-ATA watch when it is due.
 */
export function roundSteps(o: {
  hourly: boolean
  archive: boolean
  ataWatch: boolean
}): RoundStep[] {
  return [
    'tick',
    'index',
    ...(o.hourly ? (['schedule', 'treasury'] as const) : []),
    ...(o.hourly && o.archive ? (['archive'] as const) : []),
    ...(o.ataWatch ? (['ata-watch'] as const) : []),
  ]
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
