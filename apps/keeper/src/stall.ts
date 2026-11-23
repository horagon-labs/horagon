// A guard against a keeper that waits forever on something that never answers (a database
// response lost between the pooler and postgres.js: the driver has no query timeout). It
// records the time of the last activity (a step starting or ending, a heartbeat, a log line, a
// finished RPC call); when nothing has happened for the stall limit, the process exits and
// systemd (`Restart=always`) starts it again, which re-plans from the chain.
import type { Logger } from 'pino'

/** How often the guard looks, and the default and the least stall limit (env KEEPER_STALL_SECS). */
export const STALL_CHECK_MS = 15_000
export const DEFAULT_STALL_SECS = 120
export const MIN_STALL_SECS = 30

export class StallGuard {
  private last: number
  private current: string | null = null

  constructor(
    readonly stallSecs: number,
    private readonly nowMs: () => number = Date.now,
  ) {
    this.last = nowMs()
  }

  /** Something happened: the clock restarts. */
  touch(): void {
    this.last = this.nowMs()
  }

  /** A round step starts (`name`) or ends (`null`); both count as activity. */
  step(name: string | null): void {
    this.current = name
    this.touch()
  }

  /** The silence so far, and the step in progress, once it reaches the limit. */
  check(): { stalledSecs: number; step: string | null } | null {
    const stalledSecs = Math.floor((this.nowMs() - this.last) / 1000)
    return stalledSecs >= this.stallSecs ? { stalledSecs, step: this.current } : null
  }
}

/**
 * Checks `guard` every `STALL_CHECK_MS` on a timer that never keeps the process alive. On a
 * stall: one fatal log line, the logger flushed, then `exit(1)`. No alert first (it may need
 * the same stuck resources): the watchdog's missing heartbeat already tells the guardian.
 */
export function watchStall(
  guard: StallGuard,
  log: Pick<Logger, 'fatal' | 'flush'>,
  exit: (code: number) => void = (code) => process.exit(code),
  intervalMs = STALL_CHECK_MS,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    const stall = guard.check()
    if (!stall) return
    log.fatal(stall, 'keeper stalled: exiting so the service restarts')
    try {
      log.flush()
    } catch {}
    exit(1)
  }, intervalMs)
  timer.unref()
  return timer
}
