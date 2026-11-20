// Watches the token accounts whose rent the sponsor paid (spec 9, Tier 0 final review). The user
// owns each one and can close it to any address, so the rent is spend, not float. A close whose
// rent went anywhere but the sponsor is recorded and alerted, and the API then opens no more
// accounts for that wallet (`atasClosedAway`).
import { type Db, markAtaClosed, markAtasChecked, sponsoredAtasToCheck } from '@horagon/db'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { type Connection, PublicKey, type VersionedTransactionResponse } from '@solana/web3.js'
import type { Logger } from 'pino'
import type { Alerter } from './alerts'

/** SPL Token `CloseAccount`: accounts [account, destination, owner]. */
const CLOSE_ACCOUNT = 9
const TOKEN_PROGRAMS = [TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()]

export interface AtaWatchDeps {
  db: Db
  connection: Pick<
    Connection,
    'getMultipleAccountsInfo' | 'getSignaturesForAddress' | 'getTransaction'
  >
  sponsor: PublicKey
  alerts: Alerter
  log: Logger
  now: () => number
  /** ATAs checked per pass (one getMultipleAccountsInfo call). */
  batch?: number
}

/** Where `tx` sent the rent of `ata` when it closed it; undefined when it did not close it. */
export function closeDestination(
  tx: VersionedTransactionResponse,
  ata: string,
): string | undefined {
  const msg = tx.transaction.message
  const keys = msg.getAccountKeys({
    ...(tx.meta?.loadedAddresses ? { accountKeysFromLookups: tx.meta.loadedAddresses } : {}),
  })
  for (const ix of msg.compiledInstructions) {
    const program = keys.get(ix.programIdIndex)?.toBase58()
    if (!program || !TOKEN_PROGRAMS.includes(program) || ix.data[0] !== CLOSE_ACCOUNT) continue
    const [account, destination] = ix.accountKeyIndexes.map((i) => keys.get(i)?.toBase58())
    if (account === ata && destination) return destination
  }
  return undefined
}

async function findClose(
  deps: AtaWatchDeps,
  ata: string,
): Promise<{ sig: string | null; to: string }> {
  const sigs = await deps.connection.getSignaturesForAddress(
    new PublicKey(ata),
    { limit: 10 },
    'confirmed',
  )
  for (const s of sigs) {
    if (s.err) continue
    const tx = await deps.connection.getTransaction(s.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    const to = tx ? closeDestination(tx, ata) : undefined
    if (to) return { sig: s.signature, to }
  }
  // Closed by an instruction inside another program, or older than the last 10 signatures.
  return { sig: null, to: 'unknown' }
}

/** One pass over the least recently checked open ATAs. */
export async function watchSponsoredAtas(
  deps: AtaWatchDeps,
): Promise<{ checked: number; closed: number; flagged: number }> {
  const rows = await sponsoredAtasToCheck(deps.db, deps.batch ?? 100)
  if (rows.length === 0) return { checked: 0, closed: 0, flagged: 0 }
  const now = new Date(deps.now() * 1000)
  const infos = await deps.connection.getMultipleAccountsInfo(
    rows.map((r) => new PublicKey(r.ata)),
    'confirmed',
  )
  const stillOpen: string[] = []
  let closed = 0
  let flagged = 0
  for (const [i, row] of rows.entries()) {
    if (infos[i]) {
      stillOpen.push(row.ata)
      continue
    }
    const { sig, to } = await findClose(deps, row.ata)
    // Guarded by the creation we traced: a newer creation of this address stays open.
    await markAtaClosed(deps.db, row.ata, {
      closedSig: sig,
      closedAt: now,
      closedTo: to,
      createdSig: row.createdSig,
    })
    closed++
    if (to === deps.sponsor.toBase58()) continue
    flagged++
    deps.log.warn({ wallet: row.wallet, ata: row.ata, to }, 'sponsor-paid ATA closed elsewhere')
    await deps.alerts.send(
      `ata-close:${row.wallet}`,
      `Wallet ${row.wallet} closed sponsor-paid ATA ${row.ata}, rent to ${to}; the sponsor opens no more accounts for it`,
    )
  }
  await markAtasChecked(deps.db, stillOpen, now)
  return { checked: rows.length, closed, flagged }
}
