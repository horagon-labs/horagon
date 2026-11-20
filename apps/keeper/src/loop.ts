// Small pieces of the keeper's main loop (`main.ts`), kept apart so they are unit tested: one
// step that fails on its own, a gate for periodic steps, and the failure streaks that page when
// the tick or the indexer keeps failing.
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
