// The study script (R10), end to end on fixture accounts: no RPC is ever reached. The connection
// handed to the fixture path throws on every call, which proves it.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HORAGON_PROGRAM_ID, PM_AMM_PROGRAM_ID } from '@horagon/sdk'
import { StudySnapshotSchema } from '@horagon/sdk/study'
import type { AccountInfo, PublicKey } from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import { type FixtureAccount, main, runStudy, type StudyConnection } from '../scripts/study'
import { DEVNET_GENESIS_HASH } from '../src/config'
import { marketInfo, poolAt } from './agent-fixtures'
import { account, type GameFields, gameMarketBytes, program, S, STATUS } from './chain-fixtures'

const TESTNET_GENESIS_HASH = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'
const NOW = new Date('2026-11-28T09:00:00.000Z')
const authority = program.authority

interface Case {
  id: bigint
  game: GameFields
  market?: { resolved: boolean; winningSide: number; bps: number }
}

// 2026-11-26T00:30Z is on the ET night of 2026-11-25.
const TIP = Date.parse('2026-11-26T00:30:00Z') / 1000
const CASES: Case[] = [
  {
    id: 11n,
    game: { home: 'CHA', away: 'CHI', tipoff: TIP },
    market: { resolved: true, winningSide: 2, bps: 7_400 },
  },
  {
    id: 12n,
    game: { home: 'NYK', away: 'BOS', tipoff: TIP + 3_600 },
    market: { resolved: true, winningSide: 1, bps: 6_100 },
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
]

function chain(): Map<string, AccountInfo<Buffer>> {
  const accounts = new Map<string, AccountInfo<Buffer>>()
  for (const c of CASES) {
    const a = program.addresses(c.id)
    accounts.set(
      a.gameMarket.toBase58(),
      account(gameMarketBytes(c.id, STATUS.finalized, {}, c.game)),
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
  return accounts
}

function fixtureOf(accounts: Map<string, AccountInfo<Buffer>>): FixtureAccount[] {
  return [...accounts].map(([pubkey, info]) => ({
    pubkey,
    owner: info.owner.toBase58(),
    dataBase64: info.data.toString('base64'),
  }))
}

const throwing = new Proxy({} as StudyConnection, {
  get: () => () => {
    throw new Error('no RPC in tests')
  },
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
  it('keeps resolved kind-0 NBA markets only and lists the missing one', async () => {
    const snap = await runStudy({
      fixture: { slot: 9, accounts: fixtureOf(chain()) },
      connection: throwing,
      now: NOW,
      lpSim: SIM,
    })
    expect(StudySnapshotSchema.parse(snap)).toEqual(snap)
    expect(snap.rows.map((r) => [r.home, r.away, r.initialPriceBps, r.outcome, r.night])).toEqual([
      ['CHA', 'CHI', 7_400, 'away', '2026-11-25'],
      ['NYK', 'BOS', 6_100, 'home', '2026-11-25'],
    ])
    expect(snap.rows[0]).toMatchObject({
      market: program.addresses(11n).market.toBase58(),
      gameMarket: program.addresses(11n).gameMarket.toBase58(),
      tipoff: '2026-11-26T00:30:00.000Z',
    })
    expect(snap.missing.map((m) => [m.home, m.away])).toEqual([['LAL', 'DEN']])
    expect(snap).toMatchObject({
      slot: 9,
      generatedAt: NOW.toISOString(),
      programIds: { horagon: HORAGON_PROGRAM_ID.toBase58(), pmAmm: PM_AMM_PROGRAM_ID.toBase58() },
      calibration: { n: 2, upsets: 1 },
    })
  })

  it('reads the same rows over a devnet RPC, read-only', async () => {
    const accounts = chain()
    const rpc = fakeRpc(accounts)
    const snap = await runStudy({ connection: rpc.connection, now: NOW, lpSim: SIM })
    const fixed = await runStudy({
      fixture: { slot: 4_321, accounts: fixtureOf(accounts) },
      connection: throwing,
      now: NOW,
      lpSim: SIM,
    })
    expect(snap).toEqual(fixed)
    expect(rpc.getProgramAccounts).toHaveBeenCalledTimes(1)
    // Only the kind-0 NBA markets are fetched (resolved or not): never the PRACTICE or kind-1 one.
    const asked = rpc.getMultipleAccountsInfo.mock.calls.flatMap(([keys]) =>
      keys.map((k) => k.toBase58()),
    )
    expect(asked).toHaveLength(4)
    expect(asked).not.toContain(program.addresses(13n).market.toBase58())
  })

  it('refuses a non-devnet genesis before it lists anything', async () => {
    const rpc = fakeRpc(chain(), TESTNET_GENESIS_HASH)
    await expect(runStudy({ connection: rpc.connection, now: NOW })).rejects.toThrow(/genesis/)
    expect(rpc.getProgramAccounts).not.toHaveBeenCalled()
    expect(rpc.getMultipleAccountsInfo).not.toHaveBeenCalled()
  })
})

describe('study script command line (R10)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'horagon-study-'))
  const deps = { connect: () => throwing, now: () => NOW }

  it('writes the snapshot from --fixture to --out', async () => {
    const fixture = join(dir, 'f.json')
    const out = join(dir, 'study.json')
    writeFileSync(fixture, JSON.stringify({ slot: 9, accounts: fixtureOf(chain()) }))
    await main(['--fixture', fixture, '--out', out], {}, deps)
    const snap = StudySnapshotSchema.parse(JSON.parse(readFileSync(out, 'utf8')))
    expect(snap.rows).toHaveLength(2)
  })

  it('writes the empty snapshot with --empty: no rows and no time', async () => {
    const out = join(dir, 'empty.json')
    await main(['--empty', '--out', out], {}, deps)
    const snap = StudySnapshotSchema.parse(JSON.parse(readFileSync(out, 'utf8')))
    expect(snap).toMatchObject({ generatedAt: null, slot: null, rows: [], missing: [] })
  })

  it('needs HORAGON_RPC_URL without a fixture, and never a mainnet URL', async () => {
    const out = join(dir, 'x.json')
    await expect(main(['--out', out], {}, deps)).rejects.toThrow(/HORAGON_RPC_URL/)
    await expect(
      main(['--out', out], { HORAGON_RPC_URL: 'https://api.mainnet-beta.solana.com' }, deps),
    ).rejects.toThrow(/mainnet/)
  })
})
