// The mechanism study (R10), read from chain: every resolved kind-0 NBA market's opening price
// (the model's pre-game %, written when the market opened) against its outcome, written to
// apps/web/content/study.json for the /study page. Read-only: it holds no key and sends no
// transaction. The RPC must be devnet (its genesis hash). Each resolved market's evidence is
// fetched from its on-chain URI and checked against the on-chain hash: a game not played within
// 7 days resolves NO by rule, which is no away win, so it goes to `notPlayed` and is never
// scored. A market whose pm-AMM account is gone, or whose evidence cannot be fetched or checked,
// goes to `missing`, never guessed.
//   pnpm --filter @horagon/keeper study [--fixture f.json --out path] [--out path] [--empty]
// --fixture reads {slot?, accounts: [{pubkey, owner, dataBase64}], evidence?: {uri: json}}
// instead of the RPC and the URIs, and never connects or fetches; it needs an --out other than
// the committed snapshot, so fixture rows never reach the page. --empty writes the snapshot with
// no chain rows (the depth curves and the simulation only).
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  DEVNET_MUSDC_MINT,
  decodeGameMarket,
  decodeMarketAccount,
  etNight,
  evidenceHashBytes,
  type GameMarketAccount,
  HORAGON_PROGRAM_ID,
  HoragonProgram,
  PM_AMM_PROGRAM_ID,
  parseResolutionEvidence,
} from '@horagon/sdk'
import {
  type StudyMissing,
  type StudyNotPlayed,
  type StudyRow,
  type StudySnapshot,
  StudySnapshotSchema,
  studySnapshot,
} from '@horagon/sdk/study'
import { Connection, PublicKey } from '@solana/web3.js'
import { z } from 'zod'
import { assertCluster, assertNotMainnet, REPO_DIR } from '../src/config'
import { writeFileAtomic } from '../src/json-cache'
import { stripArgSeparator } from '../src/ops/args'

export const DEFAULT_OUT = join(REPO_DIR, 'apps/web/content/study.json')
/** The simulation every published snapshot carries. */
export const LP_SIM = { seed: 2026, paths: 2_000 }
/** getMultipleAccountsInfo takes at most 100 keys. */
const CHUNK = 100
/** Evidence fetches at a time, and how long each may take. */
const EVIDENCE_CONCURRENCY = 8
const EVIDENCE_TIMEOUT_MS = 10_000
/** Evidence JSON is well under a kilobyte; anything far larger is not evidence. */
const EVIDENCE_MAX_CHARS = 64 * 1024

export type StudyConnection = Pick<
  Connection,
  'getGenesisHash' | 'getSlot' | 'getProgramAccounts' | 'getMultipleAccountsInfo'
>

const FixtureAccountSchema = z.strictObject({
  pubkey: z.string(),
  owner: z.string(),
  dataBase64: z.base64(),
})
const FixtureSchema = z.strictObject({
  slot: z.number().int().nonnegative().optional(),
  accounts: z.array(FixtureAccountSchema),
  /** The evidence JSON each URI serves; a URI not listed fails like a failed fetch. */
  evidence: z.record(z.string(), z.string()).optional(),
})
export type FixtureAccount = z.infer<typeof FixtureAccountSchema>
export type StudyFixture = z.infer<typeof FixtureSchema>

/** The evidence JSON published at an on-chain URI; throws when it cannot be had. */
export type EvidenceFetch = (uri: string) => Promise<string>

/** GET over https only, with a timeout; a status that is not OK throws. */
export async function httpEvidence(uri: string): Promise<string> {
  const url = new URL(uri)
  if (url.protocol !== 'https:') throw new Error(`evidence URI is not https: ${uri}`)
  const res = await fetch(url.href, { signal: AbortSignal.timeout(EVIDENCE_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`evidence ${uri}: HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > EVIDENCE_MAX_CHARS) throw new Error(`evidence ${uri}: too large`)
  return text
}

const fixtureEvidence =
  (evidence: Record<string, string> = {}): EvidenceFetch =>
  async (uri) => {
    const json = Object.hasOwn(evidence, uri) ? evidence[uri] : undefined
    if (json === undefined) throw new Error(`no evidence in the fixture for ${uri}`)
    return json
  }

interface AccountLike {
  owner: PublicKey
  data: Uint8Array
}

interface ChainRead {
  slot: number | null
  gameMarkets: Array<{ pubkey: string; account: GameMarketAccount }>
  /** pm-AMM Market accounts by address; null when the account is gone. */
  markets: Map<string, AccountLike | null>
}

const program = new HoragonProgram({ collateralMint: DEVNET_MUSDC_MINT })

/** Kind-0 NBA markets: never PRACTICE, never kind 1. */
const isCounted = (g: GameMarketAccount) => g.kind === 0 && g.league === 'NBA'

async function readRpc(connection: StudyConnection): Promise<ChainRead> {
  // Before anything else: refuse any cluster but devnet.
  await assertCluster(connection, 'devnet')
  const slot = await connection.getSlot('confirmed')
  const listed = await program.listGameMarkets(connection as Connection)
  const gameMarkets = listed
    .filter((g) => isCounted(g.account))
    .map((g) => ({ pubkey: g.pubkey.toBase58(), account: g.account }))
  const markets = new Map<string, AccountLike | null>()
  const keys = gameMarkets.map((g) => g.account.market)
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK)
    const infos = await connection.getMultipleAccountsInfo(chunk, 'confirmed')
    chunk.forEach((k, j) => {
      markets.set(k.toBase58(), infos[j] ?? null)
    })
  }
  return { slot, gameMarkets, markets }
}

function readFixture(fixture: StudyFixture): ChainRead {
  const byKey = new Map<string, AccountLike>()
  for (const a of fixture.accounts) {
    byKey.set(a.pubkey, {
      owner: new PublicKey(a.owner),
      data: Uint8Array.from(Buffer.from(a.dataBase64, 'base64')),
    })
  }
  const gameMarkets: ChainRead['gameMarkets'] = []
  for (const [pubkey, info] of byKey) {
    if (!info.owner.equals(HORAGON_PROGRAM_ID)) continue
    let account: GameMarketAccount
    try {
      account = decodeGameMarket(info, HORAGON_PROGRAM_ID)
    } catch {
      continue // a Config or another account of the program
    }
    if (isCounted(account)) gameMarkets.push({ pubkey, account })
  }
  const markets = new Map<string, AccountLike | null>()
  for (const g of gameMarkets) {
    const key = g.account.market.toBase58()
    markets.set(key, byKey.get(key) ?? null)
  }
  return { slot: fixture.slot ?? null, gameMarkets, markets }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i])

/**
 * What the market's evidence says about the game: 'final' or 'postponed'; null when it cannot be
 * fetched, does not hash to the hash on chain, fails the SDK's validator, or names another game
 * or another outcome than the pm-AMM account.
 */
async function checkedStatus(
  g: GameMarketAccount,
  winningSide: 1 | 2,
  fetchEvidence: EvidenceFetch,
): Promise<'final' | 'postponed' | null> {
  if (g.evidenceUri === '' || g.evidenceHash.every((b) => b === 0)) return null
  try {
    const value: unknown = JSON.parse(await fetchEvidence(g.evidenceUri))
    if (!sameBytes(await evidenceHashBytes(value), g.evidenceHash)) return null
    const e = parseResolutionEvidence(value)
    const sameGame =
      e.kind === 0 &&
      e.league === g.league &&
      e.gameId === g.externalGameId &&
      e.home === g.home &&
      e.away === g.away
    if (!sameGame || e.outcome !== (winningSide === 1 ? 'yes' : 'no')) return null
    return e.status === 'postponed' ? 'postponed' : 'final'
  } catch {
    return null
  }
}

export interface Selected {
  rows: StudyRow[]
  missing: StudyMissing[]
  notPlayed: StudyNotPlayed[]
}

interface Resolved {
  g: GameMarketAccount
  base: StudyNotPlayed
  bps: number
  side: 1 | 2
}

/**
 * Resolved (winningSide 1 or 2) markets only: a row when the checked evidence says the game was
 * played, `notPlayed` when it says the game was not, `missing` when the account is gone or the
 * evidence fails.
 */
export async function selectRows(read: ChainRead, fetchEvidence: EvidenceFetch): Promise<Selected> {
  const out: Selected = { rows: [], missing: [], notPlayed: [] }
  const resolved: Resolved[] = []
  for (const { pubkey, account: g } of read.gameMarkets) {
    if (!isCounted(g)) continue
    const market = g.market.toBase58()
    const base = {
      market,
      gameMarket: pubkey,
      home: g.home,
      away: g.away,
      tipoff: new Date(g.scheduledTipoff * 1000).toISOString(),
      night: etNight(g.scheduledTipoff),
    }
    const info = read.markets.get(market) ?? null
    if (info === null) {
      out.missing.push({ ...base, reason: 'account' })
      continue
    }
    const m = decodeMarketAccount(info)
    if (!m.resolved || (m.winningSide !== 1 && m.winningSide !== 2)) continue
    resolved.push({ g, base, bps: m.initialPriceBps, side: m.winningSide })
  }
  for (let i = 0; i < resolved.length; i += EVIDENCE_CONCURRENCY) {
    const batch = resolved.slice(i, i + EVIDENCE_CONCURRENCY)
    const statuses = await Promise.all(batch.map((r) => checkedStatus(r.g, r.side, fetchEvidence)))
    batch.forEach((r, j) => {
      const status = statuses[j] ?? null
      if (status === null) out.missing.push({ ...r.base, reason: 'evidence' })
      else if (status === 'postponed') out.notPlayed.push(r.base)
      else
        out.rows.push({
          ...r.base,
          initialPriceBps: r.bps,
          outcome: r.side === 1 ? 'home' : 'away',
        })
    })
  }
  return out
}

const programIds = { horagon: HORAGON_PROGRAM_ID.toBase58(), pmAmm: PM_AMM_PROGRAM_ID.toBase58() }

export interface RunStudyInput {
  /** Read these accounts and evidence instead of the RPC and the URIs; nothing is then fetched. */
  fixture?: StudyFixture
  connection?: StudyConnection
  /** Fetches the evidence on the RPC path (default: `httpEvidence`). */
  fetchEvidence?: EvidenceFetch
  now: Date
  lpSim?: { seed: number; paths: number }
}

export async function runStudy(input: RunStudyInput): Promise<StudySnapshot> {
  let read: ChainRead
  let fetchEvidence: EvidenceFetch
  if (input.fixture) {
    read = readFixture(input.fixture)
    fetchEvidence = fixtureEvidence(input.fixture.evidence)
  } else if (input.connection) {
    read = await readRpc(input.connection)
    fetchEvidence = input.fetchEvidence ?? httpEvidence
  } else throw new Error('runStudy needs a fixture or a connection')
  const { rows, missing, notPlayed } = await selectRows(read, fetchEvidence)
  return studySnapshot({
    generatedAt: input.now.toISOString(),
    slot: read.slot,
    programIds,
    rows,
    missing,
    notPlayed,
    lpSim: input.lpSim ?? LP_SIM,
  })
}

/** The snapshot before the script's first run: no rows and no time. */
export function emptyStudy(lpSim = LP_SIM): StudySnapshot {
  return studySnapshot({
    generatedAt: null,
    slot: null,
    programIds,
    rows: [],
    missing: [],
    notPlayed: [],
    lpSim,
  })
}

export interface MainDeps {
  connect: (url: string) => StudyConnection
  /** Default: `httpEvidence`. */
  fetchEvidence?: EvidenceFetch
  now?: () => Date
}

export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  deps: MainDeps,
): Promise<StudySnapshot> {
  const { values } = parseArgs({
    args: stripArgSeparator(argv),
    options: {
      fixture: { type: 'string' },
      out: { type: 'string' },
      empty: { type: 'boolean' },
    },
  })
  const now = deps.now?.() ?? new Date()
  const out = resolve(values.out ?? DEFAULT_OUT)
  if (values.fixture && !values.empty && (!values.out || relative(out, DEFAULT_OUT) === '')) {
    // Fixture rows are not chain data: they never go to the snapshot the page imports.
    throw new Error('--fixture needs --out, and not the committed apps/web/content/study.json')
  }
  let snapshot: StudySnapshot
  if (values.empty) {
    snapshot = emptyStudy()
  } else if (values.fixture) {
    const fixture = FixtureSchema.parse(JSON.parse(await readFile(values.fixture, 'utf8')))
    snapshot = await runStudy({ fixture, now })
  } else {
    const url = env.HORAGON_RPC_URL
    if (!url) throw new Error('HORAGON_RPC_URL is not set (or pass --fixture)')
    assertNotMainnet(url)
    snapshot = await runStudy({
      connection: deps.connect(url),
      fetchEvidence: deps.fetchEvidence ?? httpEvidence,
      now,
    })
  }
  await mkdir(dirname(out), { recursive: true })
  await writeFileAtomic(out, `${JSON.stringify(StudySnapshotSchema.parse(snapshot), null, 2)}\n`)
  return snapshot
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const snapshot = await main(process.argv.slice(2), process.env, {
    connect: (url) => new Connection(url, 'confirmed'),
  })
  console.log(
    `study: ${snapshot.rows.length} markets, ${snapshot.notPlayed.length} not played, ` +
      `${snapshot.missing.length} missing, ${snapshot.nights.length} ET nights, ` +
      `slot ${snapshot.slot ?? 'none'}`,
  )
}
