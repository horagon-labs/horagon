// Which evidence `horagon-ops propose` sends, so that a re-run never publishes evidence whose
// hash the chain does not hold. The API serves the one `evidence` row of a game, and the chain
// keeps the hash of whichever propose lands. A propose that ended unresolved may still land,
// so a re-run with the same inputs rebuilds the same evidence (the stored `confirmedAt`) and
// sends it again without writing; with other inputs it refuses, unless `--replace-evidence` is
// passed and nothing sent earlier can still land.
//
// Every attempt is recorded before it is sent, in the `keeper_heartbeats` row
// `propose:<gameId>`: the evidence hash it carries, the challenge round, and how the send
// ended (the signature and the block height when it ended unresolved).
import {
  type Db,
  type getDraft,
  getEvidence,
  getHeartbeat,
  heartbeat,
  putEvidence,
  upsertDraft,
} from '@horagon/db'
import { errorSummary, parseResolutionEvidence, type ResolutionEvidence } from '@horagon/sdk'
import { z } from 'zod'
import { type SealedEvidence, sealEvidence } from '../evidence'

/** `keeper_heartbeats.process` of a game's propose record. */
export const proposeRecordKey = (gameId: string) => `propose:${gameId}`

/**
 * Blocks past the block height read when an attempt ended unresolved, after which it cannot
 * land: a blockhash lives 150 blocks; 50 more cover an RPC behind the one that sent it.
 */
export const ATTEMPT_EXPIRY_BLOCKS = 200
/** An unresolved attempt without a height read: seconds after its end that it may still land. */
export const UNRESOLVED_WAIT_SECS = 300
/** A send that never recorded its end (still running, or stopped): seconds it may still land. */
export const SENDING_WAIT_SECS = 900

const AttemptSchema = z.object({
  /** Unix seconds when the send began. */
  at: z.number().int(),
  state: z.enum(['sending', 'unresolved', 'landed', 'failed']),
  sig: z.string().optional(),
  /** Unix seconds when the send ended. */
  ended: z.number().int().optional(),
  /** The confirmed block height read when the send ended unresolved. */
  height: z.number().int().optional(),
})
const RecordSchema = z.object({
  hash: z.string(),
  /** The on-chain challenge count when the attempts were sent. */
  round: z.number().int(),
  attempts: z.array(AttemptSchema),
})

export type ProposeAttempt = z.infer<typeof AttemptSchema>
export type ProposeRecord = z.infer<typeof RecordSchema>

/** The `propose:<gameId>` record: null when there is none, 'unreadable' when it does not parse. */
export async function readProposeRecord(
  db: Db,
  gameId: string,
): Promise<ProposeRecord | 'unreadable' | null> {
  const row = await getHeartbeat(db, proposeRecordKey(gameId))
  if (!row) return null
  const parsed = RecordSchema.safeParse(row.info)
  return parsed.success ? parsed.data : 'unreadable'
}

export async function writeProposeRecord(
  db: Db,
  gameId: string,
  record: ProposeRecord,
): Promise<void> {
  await heartbeat(db, proposeRecordKey(gameId), record)
}

/**
 * The record with one more attempt, `sending`, and that attempt's index. The attempts of other
 * evidence or of an earlier round are dropped. `--replace-evidence` has checked them first
 * (`pendingVerdict`); a reused send carries the same hash as the challenged proposal, so one of
 * its earlier attempts that lands late changes nothing, and for any other mismatch the keeper's
 * `evidence-mismatch:` alert fires.
 */
export function startAttempt(
  record: ProposeRecord | 'unreadable' | null,
  hash: string,
  round: number,
  at: number,
): { record: ProposeRecord; index: number } {
  const same = record && record !== 'unreadable' && record.hash === hash && record.round === round
  const attempts = same ? record.attempts : []
  return {
    record: { hash, round, attempts: [...attempts, { at, state: 'sending' }] },
    index: attempts.length,
  }
}

/** The record with attempt `index` ended as `end`. */
export function endAttempt(
  record: ProposeRecord,
  index: number,
  end: Omit<ProposeAttempt, 'at'>,
): ProposeRecord {
  return {
    ...record,
    attempts: record.attempts.map((a, i) => (i === index ? { at: a.at, ...end } : a)),
  }
}

/** What the chain says about an earlier attempt. */
export interface AttemptLookups {
  /** The signature's status (searching history), or null when no node has seen it. */
  status(sig: string): Promise<{ err: unknown; confirmationStatus?: string | null } | null>
  /** The confirmed block height. */
  blockHeight(): Promise<number>
}

const iso = (secs: number) => new Date(secs * 1000).toISOString().replace(/\.000Z$/, 'Z')

/** An attempt that did land, or may still: with the words `status` and the refusals use. */
export interface Pending {
  kind: 'landed' | 'may-land'
  why: string
}
const landed = (why: string): Pending => ({ kind: 'landed', why })
const mayLand = (why: string): Pending => ({ kind: 'may-land', why })

async function attemptPending(
  a: ProposeAttempt,
  chain: AttemptLookups,
  now: number,
): Promise<Pending | null> {
  const name = a.sig ?? `the attempt sent at ${iso(a.at)}`
  switch (a.state) {
    case 'failed':
      return null
    case 'landed':
      return landed(`${name} landed: run status`)
    case 'sending': {
      const until = a.at + SENDING_WAIT_SECS
      return now < until
        ? mayLand(
            `a propose started at ${iso(a.at)} never recorded its end (still running, or stopped); it may land until ${iso(until)}`,
          )
        : null
    }
    case 'unresolved': {
      if (a.sig) {
        let status: Awaited<ReturnType<AttemptLookups['status']>>
        try {
          status = await chain.status(a.sig)
        } catch (err) {
          return mayLand(`cannot read the status of ${a.sig}: ${errorSummary(err).message}`)
        }
        if (status && status.confirmationStatus !== 'processed') {
          return status.err ? null : landed(`${a.sig} landed: run status`)
        }
        if (status) return mayLand(`${a.sig} is processed and may still land`)
      }
      if (a.height !== undefined) {
        let height: number
        try {
          height = await chain.blockHeight()
        } catch (err) {
          return mayLand(`cannot read the block height: ${errorSummary(err).message}`)
        }
        const last = a.height + ATTEMPT_EXPIRY_BLOCKS
        return height > last
          ? null
          : mayLand(`${name} may still land until block height ${last} (now ${height})`)
      }
      const until = (a.ended ?? a.at) + UNRESOLVED_WAIT_SECS
      return now < until ? mayLand(`${name} may still land until ${iso(until)}`) : null
    }
  }
}

/**
 * What the record says about a game now: the first attempt that landed or may still land, or
 * null when none can. Unreadable and ahead-of-the-chain records count as "may land" (fail
 * closed). In an earlier challenge round a landed attempt is expected (that proposal was
 * challenged), but an attempt that may still land is not: the program takes a propose from
 * `Challenged` without a round, so one whose blockhash is still valid can land just after the
 * challenge. Its time bound is the same as in the current round, which is longer than a
 * blockhash lives.
 */
export async function pendingVerdict(
  record: ProposeRecord | 'unreadable' | null,
  round: number,
  chain: AttemptLookups,
  nowSecs: number,
): Promise<Pending | null> {
  if (record === null) return null
  if (record === 'unreadable') return mayLand('the propose record of this game does not parse')
  if (record.round > round) {
    return mayLand(
      `the chain read is behind the last propose (challenge round ${record.round}, chain ${round}): run status`,
    )
  }
  for (const a of record.attempts) {
    const p = await attemptPending(a, chain, nowSecs)
    if (p && !(record.round < round && p.kind === 'landed')) return p
  }
  return null
}

/** Why an attempt recorded for this game may still land (or did), or null when none can. */
export async function pendingAttempt(
  record: ProposeRecord | 'unreadable' | null,
  round: number,
  chain: AttemptLookups,
  nowSecs: number,
): Promise<string | null> {
  return (await pendingVerdict(record, round, chain, nowSecs))?.why ?? null
}

/** `signature` in the short form `status` prints. */
export const shortSig = (sig: string) =>
  sig.length > 16 ? `${sig.slice(0, 8)}...${sig.slice(-4)}` : sig

/**
 * The `status` line of a game's propose record, or null without one: the newest attempt's state
 * (sending, sent, or ended), signature and round, and the pending check as `pendingAttempt`
 * decides it now: may still land, expired, or landed. `--replace-evidence` goes ahead once the
 * line ends in `pending check: expired`.
 */
export async function proposeStatusLine(
  record: ProposeRecord | 'unreadable' | null,
  round: number,
  chain: AttemptLookups,
  nowSecs: number,
): Promise<string | null> {
  if (record === null) return null
  const verdict = await pendingVerdict(record, round, chain, nowSecs)
  const check = `pending check: ${verdict ? (verdict.kind === 'landed' ? 'landed' : 'may still land') : 'expired'}`
  if (record === 'unreadable') return `  propose record: unreadable  ${check}`
  const newest = record.attempts[record.attempts.length - 1]
  if (!newest) return `  propose record: no attempt  round ${record.round}  ${check}`
  const state =
    newest.state === 'sending' ? 'sending' : newest.state === 'unresolved' ? 'sent' : 'ended'
  return `  propose attempt: ${state}  sig ${newest.sig ? shortSig(newest.sig) : 'none'}  round ${record.round}  ${check}`
}

/** A propose refused before anything was written or sent (exit 1). */
export class EvidenceRefusal extends Error {
  override name = 'EvidenceRefusal'
}

/** `sources[1].fetchedAt` of stored evidence: the guardian's confirmation time. */
export function confirmedAtOf(json: string): Date | null {
  try {
    const at = (JSON.parse(json) as { sources?: Array<{ fetchedAt?: unknown }> }).sources?.[1]
      ?.fetchedAt
    if (typeof at !== 'string') return null
    const d = new Date(at)
    return Number.isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}

export interface EvidenceChoice {
  sealed: SealedEvidence
  /** False when the stored row already holds exactly this evidence. */
  write: boolean
}

/**
 * The evidence to propose with. No stored row: sealed now, to write. A stored row rebuilt from
 * the same inputs (its own `confirmedAt`, or none for evidence without a confirming source) to
 * the same hash: reused, nothing written. Otherwise refused, unless `replace` is set and
 * `pending()` finds nothing that can still land.
 */
export async function chooseEvidence(
  db: Db,
  p: {
    gameId: string
    seal: (confirmedAt: Date) => Promise<SealedEvidence>
    now: Date
    replace: boolean
    pending: () => Promise<string | null>
  },
): Promise<EvidenceChoice> {
  const stored = await getEvidence(db, p.gameId, 0)
  if (!stored) return { sealed: await p.seal(p.now), write: true }
  const confirmedAt = confirmedAtOf(stored.json)
  if (confirmedAt) {
    const again = await p.seal(confirmedAt)
    if (again.hashHex === stored.hash) return { sealed: again, write: false }
  }
  const fresh = await p.seal(p.now)
  // Evidence with no `sources[1]` (an auto-proposal no second source checked) has no time to
  // read back: the same inputs seal to the same hash whenever they are sealed.
  if (fresh.hashHex === stored.hash) return { sealed: fresh, write: false }
  if (!p.replace) {
    throw new EvidenceRefusal(
      `${p.gameId}: the stored evidence (sha256 ${stored.hash}) was sealed from other inputs ` +
        `(score, box score, notice or draft) than this run's (sha256 ${fresh.hashHex}). An earlier ` +
        'propose with it may still land: wait until `status` shows the market proposed (then ' +
        'there is nothing to do) or its propose line ends in "pending check: expired", then re-run ' +
        'with --replace-evidence.',
    )
  }
  const why = await p.pending()
  if (why) throw new EvidenceRefusal(`${p.gameId}: --replace-evidence refused: ${why}`)
  return { sealed: fresh, write: true }
}

/** What stored evidence must hold for the keeper to send it: the game, and the draft it proposes. */
export interface DraftFacts {
  externalId: string
  status: string
  homeScore: number
  awayScore: number
}

/** The stored row read back: parsed, re-canonicalized to the same bytes, hashed; else null. */
async function readBack(json: string): Promise<SealedEvidence | null> {
  let evidence: ResolutionEvidence
  try {
    evidence = parseResolutionEvidence(JSON.parse(json))
  } catch {
    return null
  }
  const sealed = await sealEvidence(evidence)
  return sealed.json === json ? sealed : null
}

/**
 * The keeper's rule (R6): seal once, then send the stored row as it is. No stored row: sealed
 * now, to write. A stored row is read back (its canonical bytes and its sha256) and checked
 * against the game and the draft's status and score, then sent with nothing written, whatever
 * the second source says by now. A row that fails is refused: the keeper never replaces stored
 * evidence (it has no `--replace-evidence`), since a propose that carried it may still land.
 */
export async function keptEvidence(
  db: Db,
  p: {
    gameId: string
    seal: (confirmedAt: Date) => Promise<SealedEvidence>
    now: Date
    expect: DraftFacts
  },
): Promise<EvidenceChoice> {
  const stored = await getEvidence(db, p.gameId, 0)
  if (!stored) return { sealed: await p.seal(p.now), write: true }
  const sealed = await readBack(stored.json)
  const e = sealed?.evidence
  const holds =
    sealed?.hashHex === stored.hash &&
    e?.gameId === p.expect.externalId &&
    e.status === p.expect.status &&
    e.homeScore === p.expect.homeScore &&
    e.awayScore === p.expect.awayScore
  if (!sealed || !holds) {
    throw new EvidenceRefusal(
      `${p.gameId}: the stored evidence (sha256 ${stored.hash}) does not hold the ${p.expect.status} ` +
        `draft ${p.expect.homeScore}-${p.expect.awayScore}, and the keeper never replaces it: ` +
        'propose by hand (runbook B)',
    )
  }
  return { sealed, write: false }
}

/** A draft row to write, as `upsertDraft` takes it. */
export type DraftInsert = Parameters<typeof upsertDraft>[1]
type StoredDraft = NonNullable<Awaited<ReturnType<typeof getDraft>>>

/** What the operator passed for the draft: a notice (postponed) or a box-score reading (final). */
export type DraftWish =
  | { gameId: string; status: 'postponed'; notice: string }
  | {
      gameId: string
      status: 'final'
      home: number
      away: number
      /** The guardian's own period scores, or null to use the keeper's draft. */
      periods: Array<[number, number]> | null
      /** The box-score URL. */
      sourceUrl: string
    }

/**
 * Which draft `propose` uses: the stored one (`newDraft` null) or a new one built from the
 * operator's inputs (`newDraft` set, to be written only once the run is accepted); or an error
 * before anything is written. A proposed draft is never replaced (`upsertDraft` would silently
 * leave it), so it is refused. A re-run with the same reading keeps the stored draft and its
 * time, so the evidence rebuilds to the same hash.
 */
export function nextDraft(
  prior: StoredDraft | null,
  wish: DraftWish,
  now: Date,
): { draft: StoredDraft | DraftInsert; newDraft: DraftInsert | null } {
  const { gameId } = wish
  if (prior?.state === 'proposed')
    throw new Error(`${gameId}: no pending ${wish.status} draft to propose; run status`)
  const fresh = (d: Omit<DraftInsert, 'gameId' | 'fetchedAt'>) => {
    const draft: DraftInsert = { gameId, ...d, fetchedAt: now }
    return { draft, newDraft: draft }
  }
  if (wish.status === 'postponed') {
    // A postponed draft the keeper wrote keeps its ESPN source; otherwise the notice is the draft.
    if (prior?.status === 'postponed' && prior.state === 'pending')
      return { draft: prior, newDraft: null }
    return fresh({
      status: 'postponed',
      homeScore: 0,
      awayScore: 0,
      periods: [],
      sourceUrl: wish.notice,
    })
  }
  const { home, away } = wish
  let chosen: { draft: StoredDraft | DraftInsert; newDraft: DraftInsert | null }
  if (wish.periods) {
    // The guardian's own reading replaces ESPN's (after a challenge, or bad linescores).
    const same =
      prior?.state === 'pending' &&
      prior.status === 'final' &&
      prior.homeScore === home &&
      prior.awayScore === away &&
      prior.sourceUrl === wish.sourceUrl &&
      JSON.stringify(prior.periods) === JSON.stringify(wish.periods)
    chosen = same
      ? { draft: prior, newDraft: null }
      : fresh({
          status: 'final',
          homeScore: home,
          awayScore: away,
          periods: wish.periods,
          sourceUrl: wish.sourceUrl,
        })
  } else {
    if (prior?.state !== 'pending' || prior.status !== 'final')
      throw new Error(`${gameId}: no pending draft (keeper writes one 60 s after a stable Final)`)
    chosen = { draft: prior, newDraft: null }
  }
  if (chosen.draft.homeScore !== home || chosen.draft.awayScore !== away) {
    throw new Error(
      `box score ${home}-${away} differs from the draft ${chosen.draft.homeScore}-${chosen.draft.awayScore}: halt, check, then pass --periods`,
    )
  }
  return chosen
}

/**
 * `chooseEvidence` (or, with `keepStored`, the keeper's `keptEvidence`), then the writes it
 * allows in ONE transaction: the evidence (when `write`), `newDraft` (a draft this run built in
 * memory; null when the stored one is used as it is), and the propose record `record(sealed)`
 * returns (null: none). A refused run writes nothing, and a failed write leaves none of the
 * three. The transaction commits before the caller sends, so the record is on disk before the
 * propose goes out. The pending check runs before it, outside the transaction, so no DB
 * connection waits on the RPC.
 */
export async function chooseAndStoreEvidence(
  db: Db,
  p: Parameters<typeof chooseEvidence>[1] & {
    newDraft: DraftInsert | null
    record?: (sealed: SealedEvidence) => ProposeRecord | null
    keepStored?: DraftFacts
  },
): Promise<EvidenceChoice> {
  const choice = p.keepStored
    ? await keptEvidence(db, { ...p, expect: p.keepStored })
    : await chooseEvidence(db, p)
  const record = p.record?.(choice.sealed) ?? null
  await db.transaction(async (tx) => {
    if (choice.write) {
      await putEvidence(tx, {
        gameId: p.gameId,
        kind: 0,
        json: choice.sealed.json,
        hash: choice.sealed.hashHex,
      })
    }
    if (p.newDraft) await upsertDraft(tx, p.newDraft)
    if (record) await writeProposeRecord(tx, p.gameId, record)
  })
  return choice
}
