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
import { type Db, getEvidence, getHeartbeat, heartbeat } from '@horagon/db'
import { errorSummary } from '@horagon/sdk'
import { z } from 'zod'
import type { SealedEvidence } from '../evidence'

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
 * evidence or of an earlier round are dropped: none of them can land any more by then.
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

async function attemptPending(
  a: ProposeAttempt,
  chain: AttemptLookups,
  now: number,
): Promise<string | null> {
  const name = a.sig ?? `the attempt sent at ${iso(a.at)}`
  switch (a.state) {
    case 'failed':
      return null
    case 'landed':
      return `${name} landed: run status`
    case 'sending': {
      const until = a.at + SENDING_WAIT_SECS
      return now < until
        ? `a propose started at ${iso(a.at)} never recorded its end (still running, or stopped); it may land until ${iso(until)}`
        : null
    }
    case 'unresolved': {
      if (a.sig) {
        let status: Awaited<ReturnType<AttemptLookups['status']>>
        try {
          status = await chain.status(a.sig)
        } catch (err) {
          return `cannot read the status of ${a.sig}: ${errorSummary(err).message}`
        }
        if (status && status.confirmationStatus !== 'processed') {
          return status.err ? null : `${a.sig} landed: run status`
        }
        if (status) return `${a.sig} is processed and may still land`
      }
      if (a.height !== undefined) {
        let height: number
        try {
          height = await chain.blockHeight()
        } catch (err) {
          return `cannot read the block height: ${errorSummary(err).message}`
        }
        const last = a.height + ATTEMPT_EXPIRY_BLOCKS
        return height > last
          ? null
          : `${name} may still land until block height ${last} (now ${height})`
      }
      const until = (a.ended ?? a.at) + UNRESOLVED_WAIT_SECS
      return now < until ? `${name} may still land until ${iso(until)}` : null
    }
  }
}

/**
 * Why an attempt recorded for this game may still land (or did), or null when none can. Only
 * the attempts of the chain's current challenge round count: an earlier round ended with its
 * proposal challenged.
 */
export async function pendingAttempt(
  record: ProposeRecord | 'unreadable' | null,
  round: number,
  chain: AttemptLookups,
  nowSecs: number,
): Promise<string | null> {
  if (record === null) return null
  if (record === 'unreadable') return 'the propose record of this game does not parse'
  if (record.round > round) {
    return `the chain read is behind the last propose (challenge round ${record.round}, chain ${round}): run status`
  }
  if (record.round < round) return null
  for (const a of record.attempts) {
    const why = await attemptPending(a, chain, nowSecs)
    if (why) return why
  }
  return null
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
 * the same inputs (its own `confirmedAt`) to the same hash: reused, nothing written. Otherwise
 * refused, unless `replace` is set and `pending()` finds nothing that can still land.
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
  if (!p.replace) {
    throw new EvidenceRefusal(
      `${p.gameId}: the stored evidence (sha256 ${stored.hash}) was sealed from other inputs ` +
        `(score, box score, notice or draft) than this run's (sha256 ${fresh.hashHex}). An earlier ` +
        'propose with it may still land: wait until `status` shows the market proposed (then ' +
        'there is nothing to do) or that attempt expired, then re-run with --replace-evidence.',
    )
  }
  const why = await p.pending()
  if (why) throw new EvidenceRefusal(`${p.gameId}: --replace-evidence refused: ${why}`)
  return { sealed: fresh, write: true }
}
