// /verify/[market] (R6 part B): the checks a viewer can run on a result without trusting Horagon.
// The GameMarket and Config accounts come from a Solana RPC the viewer picks, the evidence from
// the URI stored on chain; this file only compares. It loads with the /verify page alone (the
// view imports it lazily), never on `/`: it pulls in web3.js for the program addresses.
import { canonicalize, parseResolutionEvidence, sha256, toHex } from '@horagon/sdk/evidence'
import {
  decodeConfig,
  decodeGameMarket,
  deriveConfig,
  deriveGameMarket,
  type GameMarketAccount,
  HORAGON_PROGRAM_ID,
} from '@horagon/sdk/program'
import { PublicKey } from '@solana/web3.js'

/** An account as getAccountInfo returns it: the owner in base58, the data decoded. */
export interface RawAccount {
  owner: string
  data: Uint8Array
}

/**
 * `getAccountInfo` over a plain-fetch JSON-RPC call (base64, confirmed): no web3 `Connection`.
 * The web never calls RPC otherwise (lib/api.ts); /verify does, from the viewer's browser to an
 * endpoint the viewer chose, so the check never rests on Horagon's servers. Null: no account.
 */
export async function rpcAccount(
  fetchFn: typeof fetch,
  endpoint: string,
  address: string,
): Promise<RawAccount | null> {
  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [address, { encoding: 'base64', commitment: 'confirmed' }],
    }),
  })
  const body = (await res.json()) as {
    result?: { value: { owner: string; data: [string, string] } | null }
    error?: { message?: string }
  }
  if (body.error) throw new Error(body.error.message ?? 'RPC error')
  const value = body.result?.value
  if (!value) return null
  const bin = atob(value.data[0])
  return { owner: value.owner, data: Uint8Array.from(bin, (c) => c.charCodeAt(0)) }
}

export interface VerifyDeps {
  account: (address: string) => Promise<RawAccount | null>
  /** The raw bytes at a URL; throws when it does not answer. */
  fetchBytes: (url: string) => Promise<Uint8Array>
}

export interface VerifyInput {
  /** The market in the page's URL. */
  market: string
  /** `Resolution.gameMarket` from the API: which account to read. */
  gameMarket: string
  /** The API's copy of the evidence, read only when the URI on chain does not answer. */
  evidenceUrl: string | null
}

export type CheckId =
  | 'owner'
  | 'address'
  | 'market'
  | 'hash'
  | 'canonical'
  | 'evidence'
  | 'proposer'

export interface Check {
  id: CheckId
  label: string
  ok: boolean
  /** The two values compared, in full. */
  values: Array<{ name: string; value: string }>
  note?: string
}

export interface VerifyResult {
  /** The status on chain; null when the account could not be read. */
  status: GameMarketAccount['status'] | null
  checks: Check[]
  /** Match, a failed check, or a result with nothing on chain to check yet (wait). */
  verdict: { kind: 'match' | 'fail' | 'wait'; text: string }
  evidenceUri: string | null
  curl: string | null
  /** Unix seconds: when the challenge window of the proposal ends (proposed_at + window). */
  windowEndsAt: number | null
}

const LABEL: Record<CheckId, string> = {
  owner: 'The account belongs to the Horagon program',
  address: 'Its address comes from the market id',
  market: 'It is the account of this market',
  hash: 'The evidence hashes to the hash on chain',
  canonical: 'The evidence is in canonical form',
  evidence: 'The evidence passes the rules and names the result on chain',
  proposer: 'The attestor or a guardian proposed it',
}

const FAILED: Record<CheckId, string> = {
  owner: 'the account is not a Horagon GameMarket',
  address: 'the address does not come from the market id',
  market: 'the account belongs to another market',
  hash: 'the evidence does not hash to the hash on chain',
  canonical: 'the evidence is not in canonical form',
  evidence: 'the evidence does not name the result on chain',
  proposer: 'the proposer is neither the attestor nor a guardian',
}

export const MATCH = 'Match: the published evidence is the one on chain'
const UNDER_REVIEW =
  'Under review: a guardian challenged the proposed result, so no evidence is on chain until a guardian proposes again.'
const NOT_PROPOSED =
  'Nothing proposed yet: the result goes on-chain automatically 3 h after tip-off.'
const FALLBACK_NOTE =
  "The URI on chain did not answer, so the evidence was read from Horagon's API copy."

const check = (id: CheckId, ok: boolean, values: Check['values'], note?: string): Check => ({
  id,
  label: LABEL[id],
  ok,
  values,
  ...(note ? { note } : {}),
})

/** An http(s) URL, or null. Only these are fetched or shown in a command. */
function httpUrl(raw: string): URL | null {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null
  } catch {
    return null
  }
}

/**
 * The command that hashes the evidence by hand. The URI is quoted for the shell; one that holds a
 * quote, or is not http(s), gets no command rather than a broken or unsafe one.
 */
export function curlLine(uri: string): string | null {
  if (!httpUrl(uri) || /['\s\\]/.test(uri)) return null
  return `curl -s '${uri}' | sha256sum`
}

const outcomeWord = (o: string | null) => (o === null ? 'none' : o.toUpperCase())

function result(
  status: VerifyResult['status'],
  checks: Check[],
  extra: Partial<VerifyResult> = {},
  pending?: string,
): VerifyResult {
  const failed = checks.find((c) => !c.ok)
  const verdict = failed
    ? { kind: 'fail' as const, text: `No match: ${FAILED[failed.id]}` }
    : pending
      ? { kind: 'wait' as const, text: pending }
      : { kind: 'match' as const, text: MATCH }
  return { status, checks, verdict, evidenceUri: null, curl: null, windowEndsAt: null, ...extra }
}

/** Every check, in order; a check that cannot run stops the ones that depend on it. */
export async function verifyMarket(deps: VerifyDeps, input: VerifyInput): Promise<VerifyResult> {
  const program = HORAGON_PROGRAM_ID.toBase58()
  const raw = await deps.account(input.gameMarket)
  let gm: GameMarketAccount | null = null
  try {
    if (raw) gm = decodeGameMarket({ owner: new PublicKey(raw.owner), data: raw.data })
  } catch {
    gm = null
  }
  const owner = check('owner', gm !== null, [
    { name: 'Program', value: program },
    { name: 'Owner', value: raw ? raw.owner : 'no account at this address' },
  ])
  if (!gm) return result(null, [owner])

  const derived = deriveGameMarket(gm.marketId).toBase58()
  const onChainMarket = gm.market.toBase58()
  const checks = [
    owner,
    check('address', derived === input.gameMarket, [
      { name: `From market id ${gm.marketId}`, value: derived },
      { name: 'Read', value: input.gameMarket },
    ]),
    check('market', onChainMarket === input.market, [
      { name: 'This page', value: input.market },
      { name: 'On chain', value: onChainMarket },
    ]),
  ]
  if (gm.status === 'challenged') return result(gm.status, checks, {}, UNDER_REVIEW)
  if (gm.status === 'open' || gm.status === 'halted') {
    return result(gm.status, checks, {}, NOT_PROPOSED)
  }

  // Proposed, finalized or recycled: the proposal's fields stay on chain.
  const extra: Partial<VerifyResult> = {
    evidenceUri: gm.evidenceUri,
    curl: curlLine(gm.evidenceUri),
  }
  const onChainHash = toHex(gm.evidenceHash)
  let bytes: Uint8Array | null = null
  let note: string | undefined
  const tries = [gm.evidenceUri, input.evidenceUrl].filter(
    (u): u is string => u !== null && httpUrl(u) !== null,
  )
  for (const [i, url] of tries.entries()) {
    try {
      bytes = await deps.fetchBytes(url)
      if (i > 0) note = FALLBACK_NOTE
      break
    } catch {
      // The next copy, if there is one.
    }
  }
  if (!bytes) {
    checks.push(
      check('hash', false, [
        { name: 'On chain', value: onChainHash },
        { name: 'Computed', value: 'the evidence could not be read' },
      ]),
    )
    return result(gm.status, checks, extra)
  }
  const computed = toHex(await sha256(Uint8Array.from(bytes)))
  checks.push(
    check(
      'hash',
      computed === onChainHash,
      [
        { name: 'On chain', value: onChainHash },
        { name: 'Computed', value: computed },
      ],
      note,
    ),
  )

  const body = new TextDecoder().decode(bytes)
  let parsed: unknown
  let canonical = ''
  try {
    parsed = JSON.parse(body)
    canonical = canonicalize(parsed)
  } catch {
    parsed = undefined
  }
  checks.push(
    check('canonical', parsed !== undefined && canonical === body, [
      { name: 'Published', value: body },
      { name: 'Canonical (RFC 8785)', value: parsed === undefined ? 'not JSON' : canonical },
    ]),
  )

  const chainSays = `${outcomeWord(gm.proposedOutcome)} · game ${gm.externalGameId} · ${gm.away} @ ${gm.home}`
  let evidenceSays: string
  let evidenceOk = false
  try {
    const e = parseResolutionEvidence(parsed)
    evidenceSays = `${outcomeWord(e.outcome)} · game ${e.gameId} · ${e.away} @ ${e.home}`
    evidenceOk = evidenceSays === chainSays && e.kind === gm.kind
  } catch (err) {
    evidenceSays = err instanceof Error ? err.message : 'not valid evidence'
  }
  checks.push(
    check('evidence', evidenceOk, [
      { name: 'On chain', value: chainSays },
      { name: 'Evidence', value: evidenceSays },
    ]),
  )

  const rawConfig = await deps.account(deriveConfig().toBase58())
  let role = 'not the attestor or a guardian'
  let windowEndsAt: number | null = null
  let configOk = false
  try {
    if (!rawConfig) throw new Error('no Config account')
    const config = decodeConfig({ owner: new PublicKey(rawConfig.owner), data: rawConfig.data })
    configOk = true
    windowEndsAt = gm.proposedAt + config.disputeWindowSecs
    if (gm.proposer.equals(config.attestor)) role = 'automated attestor'
    else if (config.guardians.some((g) => !g.equals(PublicKey.default) && g.equals(gm.proposer))) {
      role = 'guardian'
    }
  } catch {
    role = 'the Config account could not be read'
  }
  const known = role === 'automated attestor' || role === 'guardian'
  checks.push(
    check('proposer', configOk && known, [
      { name: 'Allowed', value: 'the attestor or a guardian, as Config names them' },
      { name: 'Proposer', value: `${gm.proposer.toBase58()} (${role})` },
    ]),
  )
  return result(gm.status, checks, { ...extra, windowEndsAt })
}
