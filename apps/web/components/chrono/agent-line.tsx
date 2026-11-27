// Who moves the price (R2b). AgentLine sits under the game page's dial: the reference agent's
// swaps and volume apart from the fans', from the game's `activity`, which also names the
// wallet. AgentNote is the one line under the board on /. No hooks, and not a client module of
// its own: on / the server renders it, so it ships no script.
import type { GameActivity } from '@horagon/sdk'
import Link from 'next/link'
import { AGENT_DISCLOSURE, activityLine } from '../../lib/agent'
import { DIAL_LEGEND } from '../../lib/chrono/copy'
import { explorerAddress, shortKey } from '../../lib/format'

// Ink in muted words is under 3:1 against them, so the link is underlined too (review §3.3).
const LINK = 'text-ink underline underline-offset-4'

function HowLink() {
  return (
    <Link href="/agent" className={LINK}>
      How the agent works
    </Link>
  )
}

/**
 * `trading`: the market still trades (canTrade of the dial), so the line may invite a fan. The
 * dial's legend leads it (culture review string 23): the needle and the model it explains.
 */
export function AgentLine({ activity, trading }: { activity: GameActivity; trading: boolean }) {
  const wallet = activity.agent.wallet
  return (
    <div
      className="mx-auto max-w-md space-y-1 text-center text-12 font-mono text-ink-muted"
      data-agent-line
    >
      <p className="font-sans" data-dial-legend>
        {DIAL_LEGEND}
      </p>
      <p>{activityLine(activity, trading)}</p>
      <p>
        {AGENT_DISCLOSURE} <HowLink /> ·{' '}
        <a href={explorerAddress(wallet)} target="_blank" rel="noreferrer" className={LINK}>
          Wallet {shortKey(wallet)}
        </a>
      </p>
    </div>
  )
}

export function AgentNote() {
  return (
    <p className="mt-6 text-13 text-ink-muted" data-agent-note>
      When nobody trades, a disclosed Horagon agent moves prices toward the model. It never counts
      as a fan. <HowLink />
    </p>
  )
}
