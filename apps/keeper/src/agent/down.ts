// The page when the reference agent cannot run: it failed to start (a bad AGENT_* line, the
// keypair, the cluster check, a database that does not answer the first read), or its loop
// ended on an error. Without it only the journal knows: systemd starts the unit again
// (Restart=on-failure), gives up after 5 starts in 10 min, and the agent stays down unseen.
// Each start is a new process, so the alerter's in-memory dedupe cannot hold a repeat back: the
// time of the last delivered page is kept in a file, and `agent-down` goes out at most once every
// AGENT_DOWN_REPAGE_SECS (the alerter's default window), so a failing burst pages once. A page
// Telegram did not take keeps no time, so the next start tries again. A stop by hand that ends on
// an error (the last heartbeat or the close failed after the stop signal) does not page.
// Telegram comes straight from TELEGRAM_*, since the failure may be the config itself; without
// it (or when it does not parse) only the journal line is written. Never throws.
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Logger } from 'pino'
import { telegramAlerter } from '../alerts'
import { REPO_DIR, telegramSettings } from '../config'
import { readJsonCache, writeFileAtomic } from '../json-cache'

/** Seconds between two `agent-down` pages, across processes. */
export const AGENT_DOWN_REPAGE_SECS = 600

/** Where the last page time is kept: apps/keeper/data, which a deploy never overwrites. */
export const AGENT_DOWN_FILE = join(REPO_DIR, 'apps/keeper/data/agent-down.json')

export type AgentDownPhase = 'start' | 'run'

export interface AgentDownOptions {
  env: NodeJS.ProcessEnv
  log: Logger
  /** The file that keeps the last page time (default AGENT_DOWN_FILE). */
  file?: string
  /** Unix seconds. */
  nowSecs?: () => number
  fetchImpl?: typeof fetch
}

/** The journal line, and the start of the page. `message` is already redacted. */
export function agentDownLine(phase: AgentDownPhase, message: string): string {
  return `agent ${phase === 'start' ? 'failed to start' : 'stopped on an error'}: ${message}`
}

export function agentDownText(phase: AgentDownPhase, message: string): string {
  const what = phase === 'start' ? 'failed to start' : 'stopped on an error'
  return `Reference agent ${what}: ${message}. It trades nothing until it runs again; systemd may start it again (up to 5 starts in 10 min), then leaves it down`
}

/** `[<cluster>] [agent]`, as the running agent's alerter writes it. */
function prefixOf(env: NodeJS.ProcessEnv): string {
  const cluster = env.HORAGON_CLUSTER || 'devnet'
  return `[${cluster === 'devnet' || cluster === 'localnet' ? cluster : 'unknown cluster'}] [agent]`
}

/**
 * Pages `agent-down` unless one was delivered within the window. True when Telegram took it. The
 * time is kept only after a delivered page: one that failed (Telegram or the network down) does
 * not silence the next start's.
 */
export async function pageAgentDown(
  phase: AgentDownPhase,
  message: string,
  o: AgentDownOptions,
): Promise<boolean> {
  try {
    let telegram: ReturnType<typeof telegramSettings>
    try {
      telegram = telegramSettings(o.env)
    } catch {
      telegram = null
    }
    if (!telegram) return false
    const file = o.file ?? AGENT_DOWN_FILE
    const now = (o.nowSecs ?? (() => Math.floor(Date.now() / 1000)))()
    const last = (await readJsonCache(file)) as { pagedAt?: unknown } | null
    const pagedAt = typeof last?.pagedAt === 'number' ? last.pagedAt : null
    if (pagedAt !== null && now >= pagedAt && now - pagedAt < AGENT_DOWN_REPAGE_SECS) return false
    // The alerter never throws and reports nothing: its fetch tells whether Telegram took it.
    const baseFetch = o.fetchImpl ?? fetch
    let delivered = false
    const fetchImpl: typeof fetch = async (...args) => {
      const res = await baseFetch(...args)
      delivered = res.ok
      return res
    }
    const alerts = telegramAlerter({ ...telegram, log: o.log, prefix: prefixOf(o.env), fetchImpl })
    await alerts.send('agent-down', agentDownText(phase, message))
    if (!delivered) return false
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFileAtomic(file, JSON.stringify({ pagedAt: now }))
    } catch (err) {
      // A page that may repeat beats no page.
      o.log.warn({ error: (err as Error).name }, 'agent: the time of the agent-down page not kept')
    }
    return true
  } catch (err) {
    o.log.warn({ error: (err as Error).name }, 'agent: the agent-down page failed')
    return false
  }
}
