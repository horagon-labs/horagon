// The challenge window of a proposed result: `Config.disputeWindowSecs` on chain, read and never
// guessed (900 today). Shared by R7's My Game-day and R6 part B's game page. A success is kept
// 600 s per app (one reader per createApp); a failed or slow read answers null and is not kept,
// so the next request reads again.
import type { ApiDeps } from './deps'

/** How long a window read is kept. */
export const DISPUTE_WINDOW_TTL_MS = 600_000
/** A read slower than this answers null. */
export const DISPUTE_WINDOW_TIMEOUT_MS = 1_000

export function disputeWindowReader(
  deps: Pick<ApiDeps, 'program' | 'connection'>,
): () => Promise<number | null> {
  let kept: { secs: number; at: number } | null = null
  let reading: Promise<number | null> | null = null

  async function read(): Promise<number | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), DISPUTE_WINDOW_TIMEOUT_MS)
    })
    try {
      const config = await Promise.race([
        deps.program.fetchConfig(deps.connection).catch(() => null),
        late,
      ])
      if (!config) return null
      kept = { secs: config.disputeWindowSecs, at: Date.now() }
      return config.disputeWindowSecs
    } finally {
      clearTimeout(timer)
    }
  }

  return () => {
    if (kept && Date.now() - kept.at < DISPUTE_WINDOW_TTL_MS) return Promise.resolve(kept.secs)
    reading ??= read().finally(() => {
      reading = null
    })
    return reading
  }
}

/**
 * When the challenge window of a proposed result ends: `proposed_at` + the window, in unix
 * seconds. Null in any other state, and when either is unknown (an unread window is never 900).
 */
export function challengeEndsAt(
  status: string,
  proposedAt: Date | null,
  windowSecs: number | null,
): number | null {
  if (status !== 'proposed' || proposedAt === null || windowSecs === null) return null
  return Math.floor(proposedAt.getTime() / 1000) + windowSecs
}
