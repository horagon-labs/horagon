// The mechanism study (R10), read from chain alone: every resolved kind-0 NBA market's opening
// price (the model's pre-game %, written when the market opened) against its outcome, written to
// apps/web/content/study.json for the /study page. Read-only: it holds no key and sends no
// transaction. The RPC must be devnet (its genesis hash); a counted market whose pm-AMM account
// is gone goes to `missing`, never guessed.
//   pnpm --filter @horagon/keeper study [--fixture f.json] [--out path] [--empty]
// --fixture reads {slot?, accounts: [{pubkey, owner, dataBase64}]} instead of the RPC; --empty
// writes the snapshot with no chain rows (the depth curves and the simulation only).
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  DEVNET_MUSDC_MINT,
  decodeGameMarket,
  decodeMarketAccount,
  etNight,
  type GameMarketAccount,
  HORAGON_PROGRAM_ID,
  HoragonProgram,
  PM_AMM_PROGRAM_ID,
} from '@horagon/sdk'
import {
  type StudyMissing,
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
})
export type FixtureAccount = z.infer<typeof FixtureAccountSchema>
export type StudyFixture = z.infer<typeof FixtureSchema>

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

/** The rows and the missing markets: resolved (winningSide 1 or 2) markets only. */
export function selectRows(read: ChainRead): { rows: StudyRow[]; missing: StudyMissing[] } {
  const rows: StudyRow[] = []
  const missing: StudyMissing[] = []
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
      missing.push(base)
      continue
    }
    const m = decodeMarketAccount(info)
    if (!m.resolved || (m.winningSide !== 1 && m.winningSide !== 2)) continue
    rows.push({
      ...base,
      initialPriceBps: m.initialPriceBps,
      outcome: m.winningSide === 1 ? 'home' : 'away',
    })
  }
  missing.sort((a, b) => a.tipoff.localeCompare(b.tipoff) || a.market.localeCompare(b.market))
  return { rows, missing }
}

const programIds = { horagon: HORAGON_PROGRAM_ID.toBase58(), pmAmm: PM_AMM_PROGRAM_ID.toBase58() }

export interface RunStudyInput {
  /** Read these accounts instead of the RPC; the connection is then never used. */
  fixture?: StudyFixture
  connection: StudyConnection
  now: Date
  lpSim?: { seed: number; paths: number }
}

export async function runStudy(input: RunStudyInput): Promise<StudySnapshot> {
  const read = input.fixture ? readFixture(input.fixture) : await readRpc(input.connection)
  const { rows, missing } = selectRows(read)
  return studySnapshot({
    generatedAt: input.now.toISOString(),
    slot: read.slot,
    programIds,
    rows,
    missing,
    lpSim: input.lpSim ?? LP_SIM,
  })
}

/** The snapshot before the script's first run: no rows and no time. */
export function emptyStudy(lpSim = LP_SIM): StudySnapshot {
  return studySnapshot({ generatedAt: null, slot: null, programIds, rows: [], missing: [], lpSim })
}

export interface MainDeps {
  connect: (url: string) => StudyConnection
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
  let snapshot: StudySnapshot
  if (values.empty) {
    snapshot = emptyStudy()
  } else if (values.fixture) {
    const fixture = FixtureSchema.parse(JSON.parse(await readFile(values.fixture, 'utf8')))
    snapshot = await runStudy({ fixture, connection: deps.connect(''), now })
  } else {
    const url = env.HORAGON_RPC_URL
    if (!url) throw new Error('HORAGON_RPC_URL is not set (or pass --fixture)')
    assertNotMainnet(url)
    snapshot = await runStudy({ connection: deps.connect(url), now })
  }
  const out = resolve(values.out ?? DEFAULT_OUT)
  await mkdir(dirname(out), { recursive: true })
  await writeFileAtomic(out, `${JSON.stringify(StudySnapshotSchema.parse(snapshot), null, 2)}\n`)
  return snapshot
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const snapshot = await main(process.argv.slice(2), process.env, {
    connect: (url) => new Connection(url, 'confirmed'),
  })
  console.log(
    `study: ${snapshot.rows.length} markets, ${snapshot.missing.length} missing, ` +
      `${snapshot.nights.length} ET nights, slot ${snapshot.slot ?? 'none'}`,
  )
}
