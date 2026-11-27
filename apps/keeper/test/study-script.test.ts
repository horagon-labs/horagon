// The study script (R10), end to end on fixture accounts: no RPC is ever reached. The connection
// handed to the fixture path throws on every call, which proves it. No test may write the
// committed snapshot: writeFileAtomic refuses DEFAULT_OUT here, even if the script asks for it.
// The evidence each market points at is served from the fixture too: no test fetches a URL.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  canonicalize,
  EVIDENCE_RULES,
  evidenceHashBytes,
  HORAGON_PROGRAM_ID,
  PM_AMM_PROGRAM_ID,
  POSTPONED_RULE,
  type ResolutionEvidence,
} from '@horagon/sdk'
import { StudySnapshotSchema } from '@horagon/sdk/study'
import type { AccountInfo, PublicKey } from '@solana/web3.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_OUT,
  httpEvidence,
  main,
  runStudy,
  type StudyConnection,
  type StudyFixture,
} from '../scripts/study'
import { DEVNET_GENESIS_HASH, REPO_DIR } from '../src/config'
import { marketInfo, poolAt } from './agent-fixtures'
import { account, type GameFields, gameMarketBytes, program, S, STATUS } from './chain-fixtures'

const writes = vi.hoisted(() => [] as string[])
vi.mock('../src/json-cache', async (importActual) => {
  const actual = await importActual<typeof import('../src/json-cache')>()
  const { join, resolve } = await import('node:path')
  const { REPO_DIR } = await import('../src/config')
  const committed = join(REPO_DIR, 'apps/web/content/study.json')
  return {
    ...actual,
    writeFileAtomic: async (file: string, data: string) => {
      writes.push(resolve(file))
      if (resolve(file) === resolve(committed)) {
        throw new Error('test tried to write the committed study.json')
      }
      await actual.writeFileAtomic(file, data)
    },
  }
})

const TESTNET_GENESIS_HASH = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'
const NOW = new Date('2026-11-28T09:00:00.000Z')
const authority = program.authority

/**
 * The evidence behind a resolved market. The published JSON matches the hash on chain unless
 * `tampered`; `unserved` publishes nothing at the URI; `otherGame` publishes valid evidence of
 * another game, under a matching hash.
 */
interface EvidenceCase {
  status: 'final' | 'postponed'
  homeScore?: number
  awayScore?: number
  tampered?: boolean
  unserved?: boolean
  otherGame?: boolean
}

interface Case {
  id: bigint
  game: GameFields
  market?: { resolved: boolean; winningSide: number; bps: number }
  evidence?: EvidenceCase
}

// 2026-11-26T00:30Z is on the ET night of 2026-11-25.
const TIP = Date.parse('2026-11-26T00:30:00Z') / 1000
const CASES: Case[] = [
  {
    id: 11n,
    game: { home: 'CHA', away: 'CHI', tipoff: TIP },
    market: { resolved: true, winningSide: 2, bps: 7_400 },
    evidence: { status: 'final', homeScore: 105, awayScore: 107 },
  },
  {
    id: 12n,
    game: { home: 'NYK', away: 'BOS', tipoff: TIP + 3_600 },
    market: { resolved: true, winningSide: 1, bps: 6_100 },
    evidence: { status: 'final', homeScore: 112, awayScore: 104 },
  },
  {
    id: 13n,
    game: { league: 'PRACTICE', tipoff: TIP },
    market: { resolved: true, winningSide: 1, bps: 5_000 },
  },
  {
    id: 14n,
    game: { kind: 1, tipoff: TIP },
    market: { resolved: true, winningSide: 1, bps: 5_000 },
  },
  { id: 15n, game: { tipoff: TIP }, market: { resolved: false, winningSide: 0, bps: 5_500 } },
  { id: 16n, game: { home: 'LAL', away: 'DEN', tipoff: S } },
  // Not played within 7 days, so NO by rule. Scored, it would be an away "upset" at 28%.
  {
    id: 17n,
    game: { home: 'MIA', away: 'ORL', tipoff: TIP + 1_800 },
    market: { resolved: true, winningSide: 2, bps: 7_200 },
    evidence: { status: 'postponed' },
  },
  {
    id: 18n,
    game: { home: 'PHX', away: 'SAC', tipoff: TIP },
    market: { resolved: true, winningSide: 1, bps: 6_500 },
    evidence: { status: 'final', homeScore: 110, awayScore: 100, tampered: true },
  },
  {
    id: 19n,
    game: { home: 'UTA', away: 'POR', tipoff: TIP },
    market: { resolved: true, winningSide: 1, bps: 5_500 },
    evidence: { status: 'final', homeScore: 110, awayScore: 100, unserved: true },
  },
  {
    id: 20n,
    game: { home: 'ATL', away: 'DET', tipoff: TIP },
    market: { resolved: true, winningSide: 1, bps: 6_000 },
    evidence: { status: 'final', homeScore: 110, awayScore: 100, otherGame: true },
  },
]

const gameIdOf = (id: bigint) => `40191${id}`
const uriOf = (id: bigint) => `https://horagon.vercel.app/api/v1/evidence/${gameIdOf(id)}/winner`
const marketOf = (id: bigint) => program.addresses(id).market.toBase58()

function evidenceOf(c: Case, e: EvidenceCase): ResolutionEvidence {
  const base = {
    v: 1 as const,
    league: 'NBA',
    gameId: e.otherGame ? '401919999' : gameIdOf(c.id),
    kind: 0 as const,
    home: c.game.home ?? 'CLE',
    away: c.game.away ?? 'MEM',
    sources: [
      { name: 'espn', url: 'https://www.espn.com/nba/game', fetchedAt: '2026-11-26T03:01:12Z' },
    ],
  }
  if (e.status === 'postponed') {
    return {
      ...base,
      homeScore: 0,
      awayScore: 0,
      periods: [],
      status: 'postponed',
      rule: POSTPONED_RULE,
      outcome: 'no',
    }
  }
  const h = e.homeScore ?? 0
  const a = e.awayScore ?? 0
  return {
    ...base,
    homeScore: h,
    awayScore: a,
    periods: [
      [25, 25],
      [25, 25],
      [25, 25],
      [h - 75, a - 75],
    ],
    status: 'final',
    rule: EVIDENCE_RULES[0],
    outcome: h > a ? 'yes' : 'no',
  }
}

/** The accounts, and the evidence JSON each URI serves. */
async function chain(): Promise<{
  accounts: Map<string, AccountInfo<Buffer>>
  evidence: Record<string, string>
}> {
  const accounts = new Map<string, AccountInfo<Buffer>>()
  const evidence: Record<string, string> = {}
  for (const c of CASES) {
    const a = program.addresses(c.id)
    let settled = {}
    if (c.evidence) {
      const e = evidenceOf(c, c.evidence)
      const uri = uriOf(c.id)
      settled = {
        outcome: c.market?.winningSide === 1 ? 0 : 1,
        evidence: await evidenceHashBytes(e),
        uri,
      }
      const served = c.evidence.tampered ? { ...e, homeScore: e.homeScore + 1 } : e
      if (!c.evidence.unserved) evidence[uri] = canonicalize(served)
    }
    const game = { ...c.game, gameId: gameIdOf(c.id) }
    accounts.set(
      a.gameMarket.toBase58(),
      account(gameMarketBytes(c.id, STATUS.finalized, settled, game)),
    )
    if (c.market) {
      const info = marketInfo({
        marketId: c.id,
        authority,
        pool: poolAt(0.5, { now: TIP }),
        resolved: c.market.resolved,
        winningSide: c.market.winningSide,
        initialPriceBps: c.market.bps,
      })
      accounts.set(a.market.toBase58(), info)
    }
  }
  return { accounts, evidence }
}

function fixtureOf(
  accounts: Map<string, AccountInfo<Buffer>>,
  evidence: Record<string, string>,
  slot: number,
): StudyFixture {
  return {
    slot,
    accounts: [...accounts].map(([pubkey, info]) => ({
      pubkey,
      owner: info.owner.toBase58(),
      dataBase64: info.data.toString('base64'),
    })),
    evidence,
  }
}

const fixture = async (slot = 9) => {
  const { accounts, evidence } = await chain()
  return fixtureOf(accounts, evidence, slot)
}

const throwing = new Proxy({} as StudyConnection, {
  get: () => () => {
    throw new Error('no RPC in tests')
  },
})

const noFetch = vi.fn(async (uri: string): Promise<string> => {
  throw new Error(`no fetch in tests (${uri})`)
})

function fakeRpc(accounts: Map<string, AccountInfo<Buffer>>, genesis = DEVNET_GENESIS_HASH) {
  const getProgramAccounts = vi.fn(async (programId: PublicKey) =>
    [...accounts]
      .filter(([, info]) => info.owner.equals(programId))
      .map(([pubkey, info]) => ({
        pubkey: { toBase58: () => pubkey } as PublicKey,
        account: info,
      })),
  )
  const getMultipleAccountsInfo = vi.fn(async (keys: PublicKey[]) =>
    keys.map((k) => accounts.get(k.toBase58()) ?? null),
  )
  const connection = {
    getGenesisHash: vi.fn(async () => genesis),
    getSlot: vi.fn(async () => 4_321),
    getProgramAccounts,
    getMultipleAccountsInfo,
  } as unknown as StudyConnection
  return { connection, getProgramAccounts, getMultipleAccountsInfo }
}

const SIM = { seed: 2026, paths: 20 }

describe('study script on fixture accounts (R10)', () => {
  it('scores resolved kind-0 NBA markets whose checked evidence says the game was played', async () => {
    const snap = await runStudy({
      fixture: await fixture(),
      connection: throwing,
      fetchEvidence: noFetch,
      now: NOW,
      lpSim: SIM,
    })
    expect(StudySnapshotSchema.parse(snap)).toEqual(snap)
    expect(snap.rows.map((r) => [r.home, r.away, r.initialPriceBps, r.outcome, r.night])).toEqual([
      ['CHA', 'CHI', 7_400, 'away', '2026-11-25'],
      ['NYK', 'BOS', 6_100, 'home', '2026-11-25'],
    ])
    expect(snap.rows[0]).toMatchObject({
      market: marketOf(11n),
      gameMarket: program.addresses(11n).gameMarket.toBase58(),
      tipoff: '2026-11-26T00:30:00.000Z',
    })
    expect(snap).toMatchObject({
      slot: 9,
      generatedAt: NOW.toISOString(),
      programIds: { horagon: HORAGON_PROGRAM_ID.toBase58(), pmAmm: PM_AMM_PROGRAM_ID.toBase58() },
      calibration: { n: 2, upsets: 1 },
    })
    expect(noFetch).not.toHaveBeenCalled()
  })

  it('lists a game not played (postponed, NO by rule) apart, never as an away win', async () => {
    const snap = await runStudy({ fixture: await fixture(), now: NOW, lpSim: SIM })
    expect(snap.notPlayed).toEqual([
      {
        market: marketOf(17n),
        gameMarket: program.addresses(17n).gameMarket.toBase58(),
        home: 'MIA',
        away: 'ORL',
        tipoff: '2026-11-26T01:00:00.000Z',
        night: '2026-11-25',
      },
    ])
    expect(snap.rows.map((r) => r.market)).not.toContain(marketOf(17n))
    // Scored as an away win, the 72% home open would add an upset and lift both scores.
    expect(snap.calibration.upsets).toBe(1)
    expect(snap.nights).toEqual([expect.objectContaining({ night: '2026-11-25', n: 2, upsets: 1 })])
  })

  it('lists a market whose account is gone, or whose evidence fails, as missing', async () => {
    const snap = await runStudy({ fixture: await fixture(), now: NOW, lpSim: SIM })
    const missing = Object.fromEntries(snap.missing.map((m) => [m.market, m.reason]))
    expect(missing).toEqual({
      [marketOf(16n)]: 'account',
      // The JSON at the URI does not hash to the hash on chain.
      [marketOf(18n)]: 'evidence',
      // Nothing is served at the URI.
      [marketOf(19n)]: 'evidence',
      // Valid JSON under the right hash, but for another game.
      [marketOf(20n)]: 'evidence',
    })
    expect(snap.missing.find((m) => m.market === marketOf(16n))).toMatchObject({
      home: 'LAL',
      away: 'DEN',
    })
    for (const id of [18n, 19n, 20n]) {
      expect(snap.rows.map((r) => r.market)).not.toContain(marketOf(id))
    }
  })

  it('reads the same rows over a devnet RPC, read-only, fetching evidence of resolved markets only', async () => {
    const { accounts, evidence } = await chain()
    const rpc = fakeRpc(accounts)
    const fetchEvidence = vi.fn(async (uri: string) => {
      const json = evidence[uri]
      if (json === undefined) throw new Error(`404 ${uri}`)
      return json
    })
    const snap = await runStudy({ connection: rpc.connection, fetchEvidence, now: NOW, lpSim: SIM })
    const fixed = await runStudy({
      fixture: fixtureOf(accounts, evidence, 4_321),
      connection: throwing,
      fetchEvidence: noFetch,
      now: NOW,
      lpSim: SIM,
    })
    expect(snap).toEqual(fixed)
    expect(rpc.getProgramAccounts).toHaveBeenCalledTimes(1)
    // Only the kind-0 NBA markets are fetched (resolved or not): never the PRACTICE or kind-1 one.
    const asked = rpc.getMultipleAccountsInfo.mock.calls.flatMap(([keys]) =>
      keys.map((k) => k.toBase58()),
    )
    expect(asked).toHaveLength(8)
    expect(asked).not.toContain(marketOf(13n))
    // Evidence only for the resolved ones: not the unresolved 15, not 16 whose account is gone.
    expect(fetchEvidence.mock.calls.map(([uri]) => uri).sort()).toEqual(
      [11n, 12n, 17n, 18n, 19n, 20n].map(uriOf).sort(),
    )
  })

  it('refuses a non-devnet genesis before it lists anything', async () => {
    const { accounts } = await chain()
    const rpc = fakeRpc(accounts, TESTNET_GENESIS_HASH)
    await expect(
      runStudy({ connection: rpc.connection, fetchEvidence: noFetch, now: NOW }),
    ).rejects.toThrow(/genesis/)
    expect(rpc.getProgramAccounts).not.toHaveBeenCalled()
    expect(rpc.getMultipleAccountsInfo).not.toHaveBeenCalled()
  })
})

describe('httpEvidence (R10)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches https only, and fails on a status that is not OK', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/404') ? new Response('nope', { status: 404 }) : new Response('{"v":1}'),
    )
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      httpEvidence('http://horagon.vercel.app/api/v1/evidence/1/winner'),
    ).rejects.toThrow(/https/)
    await expect(httpEvidence('not a url')).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(httpEvidence('https://horagon.vercel.app/404')).rejects.toThrow(/404/)
    await expect(httpEvidence('https://horagon.vercel.app/ok')).resolves.toBe('{"v":1}')
  })
})

describe('study script command line (R10)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'horagon-study-'))
  const deps = { connect: () => throwing, fetchEvidence: noFetch, now: () => NOW }

  it('writes the snapshot from --fixture to --out', async () => {
    const file = join(dir, 'f.json')
    const out = join(dir, 'study.json')
    writeFileSync(file, JSON.stringify(await fixture()))
    await main(['--fixture', file, '--out', out], {}, deps)
    const snap = StudySnapshotSchema.parse(JSON.parse(readFileSync(out, 'utf8')))
    expect(snap.rows).toHaveLength(2)
    expect(snap.notPlayed).toHaveLength(1)
  })

  it('never connects or fetches on --fixture: the real connect throws on an empty URL', async () => {
    const file = join(dir, 'f2.json')
    const out = join(dir, 'study2.json')
    writeFileSync(file, JSON.stringify(await fixture()))
    const connect = vi.fn((url: string): StudyConnection => {
      throw new Error(`Endpoint URL must start with http: or https: (${url})`)
    })
    noFetch.mockClear()
    await main(
      ['--fixture', file, '--out', out],
      {},
      { connect, fetchEvidence: noFetch, now: () => NOW },
    )
    expect(connect).not.toHaveBeenCalled()
    expect(noFetch).not.toHaveBeenCalled()
    expect(StudySnapshotSchema.parse(JSON.parse(readFileSync(out, 'utf8'))).rows).toHaveLength(2)
  })

  it('refuses --fixture without --out, or with the committed snapshot as --out', async () => {
    const file = join(dir, 'f3.json')
    writeFileSync(file, JSON.stringify(await fixture()))
    expect(resolve(DEFAULT_OUT)).toBe(resolve(REPO_DIR, 'apps/web/content/study.json'))
    writes.length = 0
    await expect(main(['--fixture', file], {}, deps)).rejects.toThrow(/--out/)
    await expect(main(['--fixture', file, '--out', DEFAULT_OUT], {}, deps)).rejects.toThrow(/--out/)
    // Refused before anything is written, not by the guard above.
    expect(writes).toEqual([])
  })

  it('writes the empty snapshot with --empty: no rows and no time', async () => {
    const out = join(dir, 'empty.json')
    await main(['--empty', '--out', out], {}, deps)
    const snap = StudySnapshotSchema.parse(JSON.parse(readFileSync(out, 'utf8')))
    expect(snap).toMatchObject({
      generatedAt: null,
      slot: null,
      rows: [],
      missing: [],
      notPlayed: [],
    })
  })

  it('needs HORAGON_RPC_URL without a fixture, and never a mainnet URL', async () => {
    const out = join(dir, 'x.json')
    await expect(main(['--out', out], {}, deps)).rejects.toThrow(/HORAGON_RPC_URL/)
    await expect(
      main(['--out', out], { HORAGON_RPC_URL: 'https://api.mainnet-beta.solana.com' }, deps),
    ).rejects.toThrow(/mainnet/)
  })
})
