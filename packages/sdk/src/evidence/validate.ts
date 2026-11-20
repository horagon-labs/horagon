import { z } from 'zod'
import { HoragonError } from '../errors'
import type { ResolutionEvidence } from './types'

const points = z.number().int().min(0).max(999)
const ISO_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

export const EvidenceSourceSchema = z.strictObject({
  name: z.string().min(1).max(32),
  url: z.url({ protocol: /^https$/ }).max(256),
  fetchedAt: z.string().regex(ISO_SECONDS, 'ISO 8601 UTC with second precision'),
})

/** Shape of `ResolutionEvidence` (spec section 7); `parseResolutionEvidence` adds the rules. */
export const ResolutionEvidenceSchema = z.strictObject({
  v: z.literal(1),
  league: z.string().regex(/^[A-Z]{2,8}$/),
  gameId: z.string().min(1).max(16),
  kind: z.union([z.literal(0), z.literal(1)]),
  home: z.string().regex(/^[A-Z]{2,4}$/),
  away: z.string().regex(/^[A-Z]{2,4}$/),
  homeScore: points,
  awayScore: points,
  periods: z.array(z.tuple([points, points])).max(12),
  status: z.enum(['final', 'postponed']),
  rule: z.string().min(1).max(64),
  outcome: z.enum(['yes', 'no']),
  sources: z.array(EvidenceSourceSchema).min(1).max(4),
})

/** `rule` values, one per market kind (spec section 6.2). */
export const EVIDENCE_RULES = { 0: 'winner-incl-ot', 1: 'second-half-q3-q4' } as const
export const POSTPONED_RULE = 'postponed-over-7-days'

/**
 * The outcome a final score implies. Kind 0: YES if the home team won, overtime included.
 * Kind 1: YES if the home team scored more in Q3 + Q4; overtime is ignored and a tie is NO.
 */
export function outcomeFor(
  kind: 0 | 1,
  homeScore: number,
  awayScore: number,
  periods: ReadonlyArray<readonly [number, number]>,
): 'yes' | 'no' {
  if (kind === 0) return homeScore > awayScore ? 'yes' : 'no'
  const q3 = periods[2]
  const q4 = periods[3]
  if (!q3 || !q4) throw new HoragonError('INVALID_INPUT', 'Second-half outcome needs Q3 and Q4')
  return q3[0] + q4[0] > q3[1] + q4[1] ? 'yes' : 'no'
}

function fail(message: string): never {
  throw new HoragonError('INVALID_INPUT', `evidence: ${message}`)
}

/**
 * Validate untrusted evidence JSON (from the API, a file, a CLI argument): the shape, then the
 * arithmetic. A final game has at least four periods that add up to the score, and the outcome
 * follows from the rule; a postponement always resolves NO.
 */
export function parseResolutionEvidence(value: unknown): ResolutionEvidence {
  const parsed = ResolutionEvidenceSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    fail(`${issue?.path.join('.') || '$'}: ${issue?.message ?? 'invalid'}`)
  }
  const e = parsed.data
  if (e.home === e.away) fail('home and away are the same team')
  if (e.status === 'postponed') {
    if (e.rule !== POSTPONED_RULE) fail(`a postponed game uses rule ${POSTPONED_RULE}`)
    if (e.outcome !== 'no') fail('a postponed game resolves NO')
    return e
  }
  if (e.rule !== EVIDENCE_RULES[e.kind]) fail(`kind ${e.kind} uses rule ${EVIDENCE_RULES[e.kind]}`)
  if (e.periods.length < 4) fail('a final game has at least 4 periods')
  const home = e.periods.reduce((sum, p) => sum + p[0], 0)
  const away = e.periods.reduce((sum, p) => sum + p[1], 0)
  if (home !== e.homeScore || away !== e.awayScore) {
    fail(`periods add up to ${home}-${away}, not ${e.homeScore}-${e.awayScore}`)
  }
  if (e.kind === 0 && e.homeScore === e.awayScore) fail('an NBA game cannot end tied')
  const expected = outcomeFor(e.kind, e.homeScore, e.awayScore, e.periods)
  if (e.outcome !== expected) fail(`outcome must be ${expected} under rule ${e.rule}`)
  return e
}
