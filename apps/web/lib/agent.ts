// The disclosed reference agent, as the site explains it (R2b): its rules for the /agent page, and
// the game page's line of who traded. GameScreen is client code, so this file value-imports
// nothing from @horagon/sdk: the counts and the agent's wallet come in the game's `activity`.
import type { GameActivity, Health } from '@horagon/sdk'
import { usdc } from './format'

/**
 * The agent's rules in display units. Each is the default in apps/keeper/src/agent/config.ts
 * (ParamsSchema) unless its comment names another file; test/agent.test.tsx reads them there.
 * When an AGENT_* value changes on the VPS, change it here in the same release.
 */
export const AGENT_PARAMS = {
  /** AGENT_INTERVAL_SECS: one round of every market this often. */
  intervalSecs: 20,
  /** AGENT_FAN_LAG_SECS: no swap this long after any other wallet's swap on the market. */
  fanLagSecs: 90,
  /** AGENT_MODEL_MAX_AGE_SECS: the model must be this fresh. */
  modelMaxAgeSecs: 60,
  /** AGENT_END_BUFFER_SECS: no swap this close to the market's end_ts. */
  endBufferSecs: 120,
  /** AGENT_BAND: no swap while the price is at most this far from the model. */
  band: 0.04,
  /** AGENT_STOP_SHORT: the target stops this short of the model. */
  stopShort: 0.02,
  /** AGENT_MAX_PER_SWAP, mUSDC. */
  maxPerSwapUsdc: 100,
  /** AGENT_MAX_PER_GAME, mUSDC per market. */
  maxPerGameUsdc: 2_000,
  /** AGENT_MAX_SWAPS_PER_GAME, per market. */
  maxSwapsPerGame: 40,
  /** ANOMALY_HOLD_SECS in apps/keeper/src/agent/guards.ts. */
  anomalyHoldSecs: 120,
  /**
   * The horn skip in apps/keeper/src/agent/decide.ts: no swap at a 0:00 clock from this period
   * on (the 4th quarter, then overtime).
   */
  hornFromPeriod: 4,
} as const

/** The agent's mode as /health reports it from the agent's own heartbeat (`Health['agent']`). */
export type AgentBeat = NonNullable<Health['agent']>

/**
 * A heartbeat older than this says the agent is not running: it beats after every round, one
 * round every AGENT_INTERVAL_SECS (20 s). The same bound as the Practice counterparty's.
 */
export const AGENT_FRESH_SECS = 120

/**
 * /agent's line on the agent's mode, read from its heartbeat on the server, never a fixed claim.
 * Null, so the page says nothing about the mode, without a heartbeat, after a clean stop, or when
 * the last beat is older than AGENT_FRESH_SECS.
 */
export function agentModeLine(beat: AgentBeat | null | undefined): string | null {
  if (!beat || beat.stopped || beat.heartbeatAgeSecs > AGENT_FRESH_SECS) return null
  return beat.dryRun
    ? 'Its heartbeat says it runs as a dry run now: it decides and sends nothing.'
    : 'Its heartbeat says it trades live now: it sends the swaps it decides.'
}

/** The rate rule (b) of docs/metrics.md, as BOT_RATE in scripts/count-fans.mjs. */
export const BOT_RATE = { swaps: 20, seconds: 300 } as const

export const AGENT_DISCLOSURE = `A disclosed Horagon agent trades toward the model, and only after ${AGENT_PARAMS.fanLagSecs} s without another trade. It never counts as a fan.`

const swaps = (n: number) => `${n} ${n === 1 ? 'swap' : 'swaps'}`

/**
 * "Reference agent: 12 swaps, 840.00 mUSDC · Fans: 3 swaps, 45.00 mUSDC", then the other team
 * or bot wallets when they traded; "No swaps yet" before any swap. With agent swaps and no fan
 * swap, the line invites a fan only while the market trades (`trading`, canTrade of the dial):
 * a final, halted or resolved game reads closed everywhere, so it says "No fan trades".
 */
export function activityLine(a: GameActivity, trading: boolean): string {
  if (a.agent.swaps + a.fans.swaps + a.others.swaps === 0) return 'No swaps yet'
  const parts = [`Reference agent: ${swaps(a.agent.swaps)}, ${usdc(a.agent.volumeUsdc)} mUSDC`]
  const noFan = trading ? 'No fan trades yet: be the first to move it' : 'No fan trades'
  parts.push(
    a.fans.swaps === 0 && a.agent.swaps > 0
      ? noFan
      : `Fans: ${swaps(a.fans.swaps)}, ${usdc(a.fans.volumeUsdc)} mUSDC`,
  )
  if (a.others.swaps > 0) parts.push(`Other team or bot wallets: ${swaps(a.others.swaps)}`)
  return parts.join(' · ')
}
