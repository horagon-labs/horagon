// The one way a result is proposed (spec 7): `horagon-ops propose`, where a guardian signs by
// hand, and the keeper's auto-propose (R6), where the attestor signs. Both re-check the chain
// (status, then the chain clock against end_ts), pick the draft and the evidence
// (`ops/propose-evidence.ts`), record the attempt before sending, send `propose_result`, and
// write the result once it landed. This returns what happened; the keeper's page texts are built
// in tick.ts, the CLI's refusals by `refusalText`.
import { type Db, getDraft, getGame, logOps, setDraftState, updateMarket } from '@horagon/db'
import {
  authorityOutcomeAtaIxs,
  errorSummary,
  GameIdSchema,
  type HoragonProgram,
  LIGHT_IX_COMPUTE_UNITS,
  MAX_EVIDENCE_URI_LEN,
} from '@horagon/sdk'
import { toHex } from '@horagon/sdk/evidence'
import type { Connection, Keypair } from '@solana/web3.js'
import { buildEvidence, type SealedEvidence, sealEvidence } from './evidence'
import { ProgramFailure, type SendResult, type TxSender } from './executor'
import { signatureIn } from './ops/args'
import {
  type AttemptLookups,
  chooseAndStoreEvidence,
  type DraftWish,
  endAttempt,
  nextDraft,
  type ProposeAttempt,
  pendingAttempt,
  readProposeRecord,
  startAttempt,
  writeProposeRecord,
} from './ops/propose-evidence'

/**
 * The API's base URL for the evidence link: https (http only on localnet), no trailing slash.
 * `horagon-ops propose` and the keeper's config both check `HORAGON_PUBLIC_URL` with it.
 */
export function publicBaseUrl(raw: string, cluster: 'devnet' | 'localnet'): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('HORAGON_PUBLIC_URL is not a URL')
  }
  const http = url.protocol === 'http:' && cluster === 'localnet'
  if (url.protocol !== 'https:' && !http) throw new Error('HORAGON_PUBLIC_URL must be https')
  return url.href.replace(/\/+$/, '')
}

/** The URI stored on chain with a winner proposal; the program takes at most 128 characters. */
export function evidenceUri(base: string, cluster: 'devnet' | 'localnet', gameId: string): string {
  const uri = `${publicBaseUrl(base, cluster)}/api/v1/evidence/${gameId}/winner`
  if (uri.length > MAX_EVIDENCE_URI_LEN)
    throw new Error(`the evidence URI is longer than ${MAX_EVIDENCE_URI_LEN} characters: ${uri}`)
  return uri
}

/** The game, its winner market row and that market's id; the errors name the game id. */
export async function marketOf(db: Db, gameId: string) {
  if (!GameIdSchema.safeParse(gameId).success) throw new Error(`"${gameId}" is not a game id`)
  const game = await getGame(db, gameId)
  if (!game) throw new Error(`no game ${gameId}`)
  const market = game.markets.find((m) => m.kind === 0)
  if (!market) throw new Error(`${gameId} has no winner market`)
  return { game, market, marketId: BigInt(market.marketId) }
}

/** The chain clock: the block time of the confirmed slot. */
export async function chainNow(connection: Connection): Promise<number> {
  const t = await connection.getBlockTime(await connection.getSlot('confirmed'))
  if (t === null) throw new Error('could not read the chain clock')
  return t
}

/** What the chain says about an earlier propose attempt. */
export const attemptLookups = (connection: Connection): AttemptLookups => ({
  status: async (sig) =>
    (await connection.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0] ??
    null,
  blockHeight: () => connection.getBlockHeight('confirmed'),
})

/** The program takes a proposal out of these statuses only. */
export const PROPOSABLE: ReadonlySet<string> = new Set(['open', 'halted', 'challenged'])

export interface ProposeDeps {
  db: Db
  connection: Connection
  program: HoragonProgram
  sender: Pick<TxSender, 'send'>
  /** The guardian (`horagon-ops`) or the attestor (the keeper); also the TxSender's payer. */
  signer: Pick<Keypair, 'publicKey'>
  /** `ops_events.actor` of the proposal. */
  actor: 'guardian' | 'keeper'
  priorityMicroLamports?: number
  /** The clock of the draft, the seal and the attempt record (default: the system clock). */
  now?: () => Date
  /** The CLI's printed lines (console.log and console.warn); the keeper passes none. */
  say?: (line: string) => void
  warn?: (line: string) => void
}

/** The source that confirms the draft: `sources[1]` of the evidence. */
export interface ConfirmSource {
  name: string
  url: string
  /** When it was read (the keeper's second source); absent, the time the evidence is sealed. */
  at?: Date
  /** Printed before the draft is chosen (a box score on the feed's own site). */
  warning?: string
}

export interface ProposeRequest {
  gameId: string
  /** `evidenceUri` of the game. */
  uri: string
  wish: DraftWish
  /** Null: the evidence carries the ESPN source alone. */
  confirm: ConfirmSource | null
  /** `--replace-evidence` (the CLI only). */
  replace: boolean
  /** The keeper: seal once, then send the stored row as it is (`keptEvidence`). */
  keepStored?: boolean
}

export type ProposeOutcome =
  /** The market is not open, halted or challenged on chain (or not there): nothing sent. */
  | { kind: 'not-proposable'; status: string | null }
  /** The chain clock is still before end_ts, which the program requires: nothing sent. */
  | { kind: 'not-yet'; endTs: number; chainNow: number }
  | {
      kind: 'landed'
      signature: string | null
      sealed: SealedEvidence
      /** The stored evidence was sent again, with nothing written. */
      reused: boolean
    }

/** The CLI's error text for a run that sent nothing. */
export function refusalText(
  gameId: string,
  out: Extract<ProposeOutcome, { kind: 'not-proposable' | 'not-yet' }>,
): string {
  return out.kind === 'not-yet'
    ? `${gameId}: proposing opens at end_ts ${new Date(out.endTs * 1000).toISOString()}`
    : `${gameId}: market is ${out.status ?? 'missing'}, nothing to propose`
}

/**
 * Proposes the game's winner result. A refused run (another draft, other stored evidence, a
 * proposed draft) throws before anything is written or sent. A send that fails throws what the
 * sender threw, after the attempt record says how it ended: a `ProgramFailure` (rejected) or
 * anything else (it may still land).
 */
export async function proposeResult(d: ProposeDeps, r: ProposeRequest): Promise<ProposeOutcome> {
  const clock = d.now ?? (() => new Date())
  const secs = () => Math.floor(clock().getTime() / 1000)
  const say = d.say ?? (() => {})
  const warn = d.warn ?? (() => {})
  const { gameId, uri, confirm } = r
  const { game, market, marketId } = await marketOf(d.db, gameId)
  const gm = await d.program.fetchGameMarket(d.connection, marketId)
  if (!gm || !PROPOSABLE.has(gm.status))
    return { kind: 'not-proposable', status: gm?.status ?? null }
  const now = await chainNow(d.connection)
  if (now < gm.endTs) return { kind: 'not-yet', endTs: gm.endTs, chainNow: now }
  if (confirm?.warning) warn(`warning: ${confirm.warning}`)
  // The draft this run proposes (nextDraft), built in memory. `newDraft` is written only once
  // the evidence choice accepts the run: a refused run leaves the stored draft, and the
  // evidence rebuilt from it, as they were.
  const prior = await getDraft(d.db, gameId)
  const { draft, newDraft } = nextDraft(prior, r.wish, clock())
  const round = gm.challengeCount
  const record = await readProposeRecord(d.db, gameId)
  const startedAt = secs()
  let started: ReturnType<typeof startAttempt> | undefined
  // A re-run sends the evidence already stored, or refuses (propose-evidence.ts). Evidence,
  // draft and the attempt's record commit together, before the send: a later --replace-evidence
  // must know the attempt may land, and the hash on chain must be fetchable.
  const { sealed, write } = await chooseAndStoreEvidence(d.db, {
    gameId,
    newDraft,
    seal: (confirmedAt) =>
      sealEvidence(
        buildEvidence(
          confirm
            ? {
                game,
                draft,
                kind: 0,
                confirmUrl: confirm.url,
                confirmSource: confirm.name,
                confirmedAt: confirm.at ?? confirmedAt,
              }
            : { game, draft, kind: 0 },
        ),
      ),
    now: clock(),
    replace: r.replace,
    pending: () => pendingAttempt(record, round, attemptLookups(d.connection), startedAt),
    record: (s) => {
      started = startAttempt(record, s.hashHex, round, startedAt)
      return started.record
    },
    ...(r.keepStored
      ? {
          keepStored: {
            externalId: game.externalId,
            status: draft.status,
            homeScore: draft.homeScore,
            awayScore: draft.awayScore,
          },
        }
      : {}),
  })
  if (!started) throw new Error('internal: the propose record was not built')
  const attempt = started
  if (!write) say(`sending the evidence an earlier propose stored (sha256 ${sealed.hashHex})`)
  const ended = async (end: Omit<ProposeAttempt, 'at' | 'ended'>) => {
    const last = endAttempt(attempt.record, attempt.index, { ...end, ended: secs() })
    await writeProposeRecord(d.db, gameId, last).catch((err) =>
      warn(`warning: the propose record was not updated: ${errorSummary(err).message}`),
    )
  }
  let res: SendResult
  try {
    res = await sendPropose(d, gameId, marketId, sealed, uri)
  } catch (err) {
    if (err instanceof ProgramFailure) {
      // Rejected: the sender proves nothing it sent is still in flight before it throws this.
      await ended({ state: 'failed' })
    } else {
      // Unresolved, or gave up: whatever was sent took its blockhash before this height read,
      // so it cannot land once the chain is ATTEMPT_EXPIRY_BLOCKS past it.
      const sig = signatureIn(errorSummary(err).message)
      const height = await d.connection.getBlockHeight('confirmed').catch(() => undefined)
      await ended({
        state: 'unresolved',
        ...(sig ? { sig } : {}),
        ...(height !== undefined ? { height } : {}),
      })
    }
    throw err
  }
  await ended({ state: 'landed', ...(res.signature ? { sig: res.signature } : {}) })
  say(
    `proposed ${sealed.evidence.outcome.toUpperCase()} for ${game.away}@${game.home} (${res.signature ?? 'already on chain'})`,
  )
  say(`evidence ${uri}  sha256 ${sealed.hashHex}`)
  await setDraftState(d.db, gameId, { state: 'proposed' })
  await updateMarket(d.db, market.pubkey, {
    status: 'proposed',
    evidenceHash: sealed.hashHex,
    ...(res.signature ? { proposeSig: res.signature } : {}),
  })
  await logOps(d.db, {
    actor: d.actor,
    action: 'propose',
    gameId,
    market: market.pubkey,
    sig: res.signature,
    detail: { outcome: sealed.evidence.outcome, hash: sealed.hashHex },
  })
  return { kind: 'landed', signature: res.signature, sealed, reused: !write }
}

function sendPropose(
  d: ProposeDeps,
  gameId: string,
  marketId: bigint,
  sealed: SealedEvidence,
  uri: string,
): Promise<SendResult> {
  return d.sender.send({
    label: `propose ${gameId}`,
    instructions: [
      ...authorityOutcomeAtaIxs(d.signer.publicKey, {
        marketId,
        programId: d.program.programId,
        pmAmmProgramId: d.program.pmAmmProgramId,
      }),
      d.program.ix.proposeResult({
        signer: d.signer.publicKey,
        marketId,
        outcome: sealed.evidence.outcome,
        evidenceHash: sealed.hash,
        evidenceUri: uri,
      }),
    ],
    computeUnits: LIGHT_IX_COMPUTE_UNITS,
    priorityMicroLamports: d.priorityMicroLamports ?? 10_000,
    // Only this proposal counts: proposed, with this evidence hash.
    isDone: async () => {
      const after = await d.program.fetchGameMarket(d.connection, marketId)
      return after?.status === 'proposed' && toHex(after.evidenceHash) === sealed.hashHex
    },
  })
}
