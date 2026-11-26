// Reads the outcome a proposal's published evidence JSON names, for the game screen's needle (spec 4.3).
// Kept apart from `state.ts`, which the board loads: moving this export out of it saved about
// 1.0 KB on `/` (measured). The SDK's validator itself still reaches `/` through the SDK.
import type { Outcome } from '@horagon/sdk'
import { parseResolutionEvidence } from '@horagon/sdk/evidence'

/** The outcome a proposal's evidence JSON names, or null when it cannot be read. */
export function proposedOutcome(json: string): Outcome | null {
  try {
    return parseResolutionEvidence(JSON.parse(json)).outcome
  } catch {
    return null
  }
}
