// The ResolutionCard's milestones (spec 3.2, 4.3): proposed, the challenge window, finalized.
// The API carries neither the proposal time nor the window's length (a config value), so the
// window is named, never timed.
import type { Resolution } from '@horagon/sdk'

export type Mark = 'done' | 'now' | 'next'

export interface Milestone {
  label: string
  mark: Mark
  /** The transaction to link, when there is one. */
  sig: string | null
}

type Fields = Pick<Resolution, 'status' | 'proposeSig' | 'finalizeSig' | 'recycleSig'>

export function milestones(r: Fields): Milestone[] {
  const settled = r.status === 'finalized' || r.status === 'recycled'
  const waiting = r.status === 'proposed' || r.status === 'challenged'
  const out: Milestone[] = [
    { label: 'Result proposed', mark: r.proposeSig ? 'done' : 'next', sig: r.proposeSig },
    {
      label: r.status === 'challenged' ? 'Result under review' : 'Challenge window',
      mark: settled ? 'done' : waiting ? 'now' : 'next',
      sig: null,
    },
    { label: 'Finalized', mark: settled ? 'done' : 'next', sig: r.finalizeSig },
  ]
  if (r.recycleSig) out.push({ label: 'Recycled', mark: 'done', sig: r.recycleSig })
  return out
}
