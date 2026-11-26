// Who moves the price (R2b). AgentLine sits under the game page's dial: the reference agent's
// swaps and volume apart from the fans', from the game's `activity`, which also names the
// wallet. AgentNote is the one line under the board on /. No hooks, and not a client module of
// its own: on / the server renders it, so it ships no script.
import type { GameActivity } from '@horagon/sdk'
import Link from 'next/link'
import { AGENT_DISCLOSURE, activityLine } from '../../lib/agent'
import { explorerAddress, shortKey } from '../../lib/format'

const LINK = 'text-lume-300 underline-offset-4 hover:underline'

function HowLink() {
  return (
    <Link href="/agent" className={LINK}>
      How the agent works
    </Link>
  )
}

export function AgentLine({ activity }: { activity: GameActivity }) {
  const wallet = activity.agent.wallet
  return (
    <div
      className="mx-auto max-w-md space-y-1 text-center text-12 font-mono text-ash-400"
      data-agent-line
    >
      <p>{activityLine(activity)}</p>
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
    <p className="mt-6 text-13 text-ash-400" data-agent-note>
      When nobody trades, a disclosed Horagon agent moves prices toward the model. It never counts
      as a fan. <HowLink />
    </p>
  )
}
