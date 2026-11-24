// Reads the outcome a proposal's published evidence JSON names, for the game screen's needle (spec 4.3).
// Kept apart from `state.ts` so the SDK's evidence validator stays out of the board's bundle.
import { type Outcome, parseResolutionEvidence } from '@horagon/sdk'

/** The outcome a proposal's evidence JSON names, or null when it cannot be read. */
export function proposedOutcome(json: string): Outcome | null {
  try {
    return parseResolutionEvidence(JSON.parse(json)).outcome
  } catch {
    return null
  }
}
