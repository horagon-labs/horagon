/** Where a fact in the evidence came from. */
export interface EvidenceSource {
  name: string
  url: string
  /** ISO 8601 UTC, second precision, e.g. "2026-11-25T03:01:12Z". */
  fetchedAt: string
}

/**
 * Resolution evidence for one market (spec section 7). Integers and strings only,
 * so its JCS bytes, and therefore its hash, are identical in every language.
 */
export interface ResolutionEvidence {
  v: 1
  league: string
  gameId: string
  /** 0 = game winner, 1 = second half. */
  kind: 0 | 1
  home: string
  away: string
  homeScore: number
  awayScore: number
  /** [home, away] points per period, overtime periods included. */
  periods: Array<[number, number]>
  status: string
  rule: string
  outcome: 'yes' | 'no'
  sources: EvidenceSource[]
}
