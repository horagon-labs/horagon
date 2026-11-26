// The disclosure check at start-up. The agent trades only from a wallet that the pre-registered
// metric already leaves out: a `team-burner` entry of docs/metrics-wallets.json (docs/metrics.md),
// added in a public commit before its first swap. The deploy ships the whole committed tree, so
// the file read here, at the repo root that AGENT_KEYPAIR resolves against, is the committed one.
// A missing or unreadable file counts as not listed: the agent then refuses to start.
import { readFileSync } from 'node:fs'
import { errorSummary } from '@horagon/sdk'

/** Relative to the repo root. */
export const WALLETS_FILE = 'docs/metrics-wallets.json'

/** The role the agent's wallet must have (the closed role list of docs/metrics.md). */
export const AGENT_ROLE = 'team-burner'

export type Listing = { listed: true } | { listed: false; reason: string }

const entryOf = (w: unknown) =>
  typeof w === 'object' && w !== null ? (w as { pubkey?: unknown; role?: unknown }) : {}

/** Whether `pubkey` is a `team-burner` entry of `teamWallets` in the wallets file at `path`. */
export function teamBurnerListing(pubkey: string, path: string): Listing {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    return {
      listed: false,
      reason: `cannot read ${WALLETS_FILE} (${errorSummary(err).code ?? 'error'})`,
    }
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { listed: false, reason: `${WALLETS_FILE} is not valid JSON` }
  }
  const wallets = entryOf(json) as { teamWallets?: unknown }
  if (!Array.isArray(wallets.teamWallets)) {
    return { listed: false, reason: `${WALLETS_FILE} has no teamWallets list` }
  }
  const mine = wallets.teamWallets.map(entryOf).filter((w) => w.pubkey === pubkey)
  if (mine.some((w) => w.role === AGENT_ROLE)) return { listed: true }
  if (mine.length > 0) {
    const roles = mine.map((w) => String(w.role)).join(', ')
    return { listed: false, reason: `listed with role ${roles}, not ${AGENT_ROLE}` }
  }
  return { listed: false, reason: 'not in teamWallets' }
}
