// Resolution evidence (spec 7) from a draft plus the guardian's box-score check, the second
// source that replaces the NBA CDN (403 everywhere, Tier 0 S4). The JSON is validated with
// the SDK's own parser before it is hashed, so the API never publishes evidence that
// `horagon verify` would reject.
import type { DraftRow, GameRow } from '@horagon/db'
import {
  canonicalize,
  EVIDENCE_RULES,
  evidenceHashBytes,
  outcomeFor,
  POSTPONED_RULE,
  parseResolutionEvidence,
  type ResolutionEvidence,
} from '@horagon/sdk'
import { toHex } from '@horagon/sdk/evidence'

/** Box-score pages the guardian may cite. ESPN is accepted with a warning: it is the feed. */
const BOX_SCORE_HOSTS: Readonly<Record<string, string>> = {
  'nba.com': 'nba',
  'www.nba.com': 'nba',
  'basketball-reference.com': 'basketball-reference',
  'www.basketball-reference.com': 'basketball-reference',
  'espn.com': 'espn-box-score',
  'www.espn.com': 'espn-box-score',
}

export type BoxScoreCheck =
  | {
      ok: true
      source: string
      warning?: string
      /** Normalised href: store this one. */
      url?: string
    }
  | { ok: false; reason: string }

export function checkBoxScoreUrl(raw: string): BoxScoreCheck {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'not a URL' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'must be https' }
  if (url.username || url.password) return { ok: false, reason: 'must not carry credentials' }
  if (url.port) return { ok: false, reason: 'must not set a port' }
  if (url.href.length > 256) return { ok: false, reason: 'longer than 256 characters' }
  const source = BOX_SCORE_HOSTS[url.hostname]
  if (!source) return { ok: false, reason: `${url.hostname} is not an allowed box-score host` }
  return source === 'espn-box-score'
    ? {
        ok: true,
        source,
        url: url.href,
        warning: 'ESPN is also the automated feed: prefer nba.com or basketball-reference.com',
      }
    : { ok: true, source, url: url.href }
}

/** ISO 8601 UTC with second precision, as `EvidenceSourceSchema` requires. */
export const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

export interface EvidenceInput {
  game: Pick<GameRow, 'league' | 'externalId' | 'home' | 'away'>
  draft: Pick<
    DraftRow,
    'status' | 'homeScore' | 'awayScore' | 'periods' | 'sourceUrl' | 'fetchedAt'
  >
  kind: 0
  /**
   * The guardian's box score (final) or postponement notice (postponed). Pass the `url` that
   * `checkBoxScoreUrl` returned, not the raw input.
   */
  confirmUrl: string
  confirmSource: string
  confirmedAt: Date
}

export function buildEvidence(p: EvidenceInput): ResolutionEvidence {
  if (p.draft.status !== 'final' && p.draft.status !== 'postponed')
    throw new Error(`draft status must be final or postponed, got "${p.draft.status}"`)
  const postponed = p.draft.status === 'postponed'
  const periods = postponed ? [] : p.draft.periods.map(([h, a]) => [h, a] as [number, number])
  const evidence: ResolutionEvidence = {
    v: 1,
    league: p.game.league,
    gameId: p.game.externalId,
    kind: p.kind,
    home: p.game.home,
    away: p.game.away,
    homeScore: postponed ? 0 : p.draft.homeScore,
    awayScore: postponed ? 0 : p.draft.awayScore,
    periods,
    status: postponed ? 'postponed' : 'final',
    rule: postponed ? POSTPONED_RULE : EVIDENCE_RULES[p.kind],
    outcome: postponed ? 'no' : outcomeFor(p.kind, p.draft.homeScore, p.draft.awayScore, periods),
    sources: [
      { name: 'espn', url: p.draft.sourceUrl, fetchedAt: isoSeconds(p.draft.fetchedAt) },
      {
        name: p.confirmSource,
        url: new URL(p.confirmUrl).href,
        fetchedAt: isoSeconds(p.confirmedAt),
      },
    ],
  }
  return parseResolutionEvidence(evidence)
}

export interface SealedEvidence {
  evidence: ResolutionEvidence
  /** Exactly the bytes that were hashed (RFC 8785). */
  json: string
  hash: Uint8Array
  hashHex: string
}

export async function sealEvidence(evidence: ResolutionEvidence): Promise<SealedEvidence> {
  const json = canonicalize(evidence)
  const hash = await evidenceHashBytes(evidence)
  return { evidence, json, hash, hashHex: toHex(hash) }
}
