// The ResolutionCard's milestones (spec 3.2, 4.3): proposed, the challenge window, finalized.
// While a result is proposed the window is timed from `challengeEndsAt` (R6 part B: the proposal
// time plus the window read on chain); when the API could not read the window it is named, never
// timed.
import type { Resolution } from '@horagon/sdk'
import { countdown } from '../format'

export type Mark = 'done' | 'now' | 'next'

export interface Milestone {
  label: string
  mark: Mark
  /** The transaction to link, when there is one. */
  sig: string | null
}

type Fields = Pick<
  Resolution,
  'status' | 'proposeSig' | 'finalizeSig' | 'recycleSig' | 'challengeEndsAt'
>

/** "Challenge window · 12:34 left", "Challenge window closed", or the bare name. */
function windowLabel(r: Fields, now: number): string {
  if (r.status === 'challenged') return 'Result under review'
  if (r.status !== 'proposed' || r.challengeEndsAt === null) return 'Challenge window'
  if (r.challengeEndsAt - now <= 0) return 'Challenge window closed'
  return `Challenge window · ${countdown(r.challengeEndsAt, now)} left`
}

/** `now`: unix seconds from useNow, so the window ticks. */
export function milestones(r: Fields, now: number): Milestone[] {
  const settled = r.status === 'finalized' || r.status === 'recycled'
  const waiting = r.status === 'proposed' || r.status === 'challenged'
  const out: Milestone[] = [
    { label: 'Result proposed', mark: r.proposeSig ? 'done' : 'next', sig: r.proposeSig },
    {
      label: windowLabel(r, now),
      mark: settled ? 'done' : waiting ? 'now' : 'next',
      sig: null,
    },
    { label: 'Finalized', mark: settled ? 'done' : 'next', sig: r.finalizeSig },
  ]
  if (r.recycleSig) out.push({ label: 'Recycled', mark: 'done', sig: r.recycleSig })
  return out
}
