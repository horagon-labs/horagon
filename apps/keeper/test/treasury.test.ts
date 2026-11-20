import { type DbHandle, schema, setFeatured, upsertMarket, upsertScheduledGames } from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import type { HoragonProgram } from '@horagon/sdk'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { Keypair, type TransactionInstruction } from '@solana/web3.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Alerter } from '../src/alerts'
import type { SendSpec } from '../src/executor'
import { DEFAULT_SEEDS } from '../src/planner'
import {
  KEEPER_MIN_LAMPORTS,
  LAMPORTS_PER_MARKET,
  type TreasuryDeps,
  treasuryTick,
  upcomingSeeds,
} from '../src/treasury'

const NOW = Date.parse('2026-11-24T15:00:00Z') / 1000
const MUSDC = 1_000_000n
const attestor = Keypair.generate()
const mint = Keypair.generate().publicKey
const authority = Keypair.generate().publicKey
const treasury = getAssociatedTokenAddressSync(mint, authority, true)
const keeperAta = getAssociatedTokenAddressSync(mint, attestor.publicKey)

type Balance = bigint | Error

class Fixture {
  tokens = new Map<string, Balance>([
    [treasury.toBase58(), 0n],
    [keeperAta.toBase58(), 0n],
  ])
  sol = new Map<string, number>([
    [authority.toBase58(), 1_000e9],
    [attestor.publicKey.toBase58(), 1e9],
  ])
  sends: SendSpec[] = []
  sendError: Error | undefined
  alerts: Array<[string, string]> = []
  logs: Array<[string, string, unknown]> = []
  faucetCalls: string[] = []
  faucetError: Error | undefined

  connection = {
    getTokenAccountBalance: async (ata: { toBase58(): string }) => {
      const b = this.tokens.get(ata.toBase58())
      if (b instanceof Error) throw b
      if (b === undefined) throw new Error('Invalid param: could not find account')
      return { value: { amount: b.toString() } }
    },
    getBalance: async (key: { toBase58(): string }) => {
      const s = this.sol.get(key.toBase58())
      if (s === undefined) throw new Error('rpc down')
      return s
    },
  }

  alerter: Alerter = {
    send: async (k, text) => {
      this.alerts.push([k, text])
    },
  }

  deps(db: TreasuryDeps['db']): TreasuryDeps {
    const log = (level: string) => (obj: unknown, msg: string) => {
      this.logs.push([level, msg, obj])
    }
    return {
      db,
      sender: {
        connection: this.connection,
        send: async (spec: SendSpec) => {
          this.sends.push(spec)
          if (this.sendError) throw this.sendError
          return { signature: 'sig-topup', attempts: 1, alreadyDone: false }
        },
      } as unknown as TreasuryDeps['sender'],
      program: { collateralMint: mint, treasury, authority } as unknown as HoragonProgram,
      attestor,
      alerts: this.alerter,
      log: { info: log('info'), warn: log('warn') } as unknown as TreasuryDeps['log'],
      seeds: DEFAULT_SEEDS,
      now: () => NOW,
      faucet: async (wallet) => {
        this.faucetCalls.push(wallet)
        if (this.faucetError) throw this.faucetError
      },
      priorityMicroLamports: 1000,
    }
  }
}

function game(id: string, tipoff: string, gameDate: string) {
  return {
    id: `nba-${id}`,
    league: 'NBA',
    externalId: id,
    gameDate,
    home: 'CLE',
    away: 'MEM',
    scheduledTipoff: new Date(tipoff),
    status: 'scheduled',
    p0: 0.6,
  }
}

describe('treasury', () => {
  let h: DbHandle
  let f: Fixture
  beforeEach(async () => {
    h = await createTestDb()
    f = new Fixture()
  })
  afterEach(async () => {
    await h.close()
  })

  const night = [
    game('1', '2026-11-25T00:00:00Z', '2026-11-24'),
    game('2', '2026-11-25T00:30:00Z', '2026-11-24'),
    game('3', '2026-11-25T01:00:00Z', '2026-11-24'),
  ]

  it('counts only scheduled games in the next 36 h without a market, by seed class', async () => {
    await upsertScheduledGames(h.db, [
      ...night,
      { ...game('4', '2026-11-25T02:00:00Z', '2026-11-24'), status: 'live' },
      game('5', '2026-11-27T00:00:00Z', '2026-11-26'),
      game('6', '2026-11-24T14:00:00Z', '2026-11-24'),
    ])
    await setFeatured(h.db, '2026-11-24', ['nba-1'])
    await upsertMarket(h.db, {
      pubkey: 'm2',
      gameId: 'nba-2',
      kind: 0,
      marketId: '2',
      gameMarketPda: 'gm',
      yesMint: 'y',
      noMint: 'n',
      initialPriceBps: 5000,
      endTs: new Date('2026-11-25T03:00:00Z'),
      seedAmount: 300_000_000n,
      status: 'open',
    })
    expect(await upcomingSeeds(f.deps(h.db))).toEqual([
      DEFAULT_SEEDS.featured, // nba-1, featured
      DEFAULT_SEEDS.regular, // nba-3; nba-2 has a market, nba-4 is live, 5 and 6 are outside
    ])
  })

  it('tops up what is missing with an ATA create and a 6-decimal transferChecked', async () => {
    await upsertScheduledGames(h.db, night)
    await setFeatured(h.db, '2026-11-24', ['nba-1'])
    f.tokens.set(treasury.toBase58(), 500n * MUSDC)
    f.tokens.set(keeperAta.toBase58(), 10_000n * MUSDC)
    // 1000 + 300 + 300 = 1600, +20% = 1920 mUSDC; 500 already there.
    const r = await treasuryTick(f.deps(h.db))
    expect(r).toEqual({ moved: 1420n * MUSDC, target: 1920n * MUSDC })
    expect(f.faucetCalls).toEqual([attestor.publicKey.toBase58()])
    expect(f.sends).toHaveLength(1)
    const [create, transfer] = f.sends[0]?.instructions ?? []
    expect(create?.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true)
    expect(create?.keys.map((k) => k.pubkey.toBase58()).slice(0, 4)).toEqual([
      attestor.publicKey.toBase58(),
      treasury.toBase58(),
      authority.toBase58(),
      mint.toBase58(),
    ])
    const t = decodeTransferCheckedInstruction(transfer as TransactionInstruction, TOKEN_PROGRAM_ID)
    expect(t.keys.source.pubkey.equals(keeperAta)).toBe(true)
    expect(t.keys.mint.pubkey.equals(mint)).toBe(true)
    expect(t.keys.destination.pubkey.equals(treasury)).toBe(true)
    expect(t.keys.owner.pubkey.equals(attestor.publicKey)).toBe(true)
    expect(t.data.amount).toBe(1420n * MUSDC)
    expect(t.data.decimals).toBe(6)
    expect(f.alerts).toEqual([])
    const ops = await h.db.select().from(schema.opsEvents)
    expect(ops).toMatchObject([
      { actor: 'keeper', action: 'top-up', sig: 'sig-topup', detail: { amount: '1420000000' } },
    ])
  })

  it('caps the transfer at what the keeper holds and alerts treasury-low', async () => {
    await upsertScheduledGames(h.db, night)
    f.tokens.set(treasury.toBase58(), 0n)
    f.tokens.set(keeperAta.toBase58(), 700n * MUSDC)
    const r = await treasuryTick(f.deps(h.db))
    expect(r.moved).toBe(700n * MUSDC)
    expect(f.alerts.map(([k]) => k)).toEqual(['treasury-low'])
    expect(f.alerts[0]?.[1]).toContain('700 mUSDC')
  })

  it('treats a missing token account as empty and sends nothing when nothing is needed', async () => {
    f.tokens.delete(treasury.toBase58())
    const none = await treasuryTick(f.deps(h.db))
    expect(none).toEqual({ moved: 0n, target: 0n })
    expect(f.sends).toHaveLength(0)

    await upsertScheduledGames(h.db, night.slice(0, 1))
    f.tokens.set(keeperAta.toBase58(), 5_000n * MUSDC)
    const r = await treasuryTick(f.deps(h.db))
    expect(r.moved).toBe(r.target)
    expect(r.target).toBe(360n * MUSDC)
  })

  it('skips the top-up and pages nobody when a balance cannot be read', async () => {
    await upsertScheduledGames(h.db, night)
    f.tokens.set(treasury.toBase58(), new Error('429 Too Many Requests'))
    f.tokens.set(keeperAta.toBase58(), 10_000n * MUSDC)
    const r = await treasuryTick(f.deps(h.db))
    expect(r).toEqual({ moved: 0n, target: 1080n * MUSDC })
    expect(f.sends).toHaveLength(0)
    expect(f.alerts).toEqual([])
    expect(
      f.logs.some(([l, m]) => l === 'warn' && m === 'treasury top-up skipped: balance unread'),
    ).toBe(true)

    f.tokens.set(treasury.toBase58(), 0n)
    f.tokens.set(keeperAta.toBase58(), new Error('timeout'))
    expect((await treasuryTick(f.deps(h.db))).moved).toBe(0n)
    expect(f.sends).toHaveLength(0)
    expect(f.alerts).toEqual([])
  })

  it('logs a failed send, still raises the SOL alert that explains it, and reports nothing moved', async () => {
    await upsertScheduledGames(h.db, night)
    f.tokens.set(keeperAta.toBase58(), 10_000n * MUSDC)
    f.sol.set(attestor.publicKey.toBase58(), 1_000)
    f.sendError = new Error('insufficient lamports for fee')
    const r = await treasuryTick(f.deps(h.db))
    expect(r.moved).toBe(0n)
    expect(f.alerts.map(([k]) => k)).toEqual(['sol-keeper', 'treasury-low'])
    expect(f.logs).toContainEqual([
      'warn',
      'treasury top-up failed',
      { error: 'insufficient lamports for fee' },
    ])
    expect(await h.db.select().from(schema.opsEvents)).toHaveLength(0)
  })

  it('reports the real amount moved when only the ops log write fails', async () => {
    await upsertScheduledGames(h.db, night)
    f.tokens.set(keeperAta.toBase58(), 10_000n * MUSDC)
    const failing = new Proxy(h.db, {
      get: (target, prop, receiver) =>
        prop === 'insert'
          ? () => {
              throw new Error('db down https://rpc.example.com/v2/SECRETKEY?k=SECRETKEY')
            }
          : Reflect.get(target, prop, receiver),
    })
    const r = await treasuryTick(f.deps(failing))
    expect(r.moved).toBe(r.target)
    expect(f.sends).toHaveLength(1)
    expect(f.alerts.map(([k]) => k)).not.toContain('treasury-low')
    expect(f.logs.some(([, m]) => m === 'treasury top-up failed')).toBe(false)
    const warn = f.logs.find(([l, m]) => l === 'warn' && m === 'treasury top-up not logged')
    expect(warn).toBeDefined()
    expect(JSON.stringify(warn)).not.toContain('SECRETKEY')
  })

  it('lets the sender ask whether the transfer already landed', async () => {
    await upsertScheduledGames(h.db, night)
    f.tokens.set(treasury.toBase58(), 100n * MUSDC)
    f.tokens.set(keeperAta.toBase58(), 10_000n * MUSDC)
    const r = await treasuryTick(f.deps(h.db))
    const isDone = f.sends[0]?.isDone
    expect(isDone).toBeDefined()
    expect(await isDone?.()).toBe(false)
    f.tokens.set(treasury.toBase58(), 100n * MUSDC + r.moved)
    expect(await isDone?.()).toBe(true)
    f.tokens.set(treasury.toBase58(), new Error('rpc 503'))
    expect(await isDone?.()).toBe(false)
  })

  it('alerts on low SOL, counting only the next Eastern game date as one night', async () => {
    // Five games on 24 Nov (ET) and one on 25 Nov (ET).
    const ids = ['1', '2', '3', '4', '5']
    await upsertScheduledGames(h.db, [
      ...ids.map((i) => game(i, '2026-11-25T00:00:00Z', '2026-11-24')),
      game('9', '2026-11-25T23:00:00Z', '2026-11-25'),
    ])
    // Two nights of five markets need 360M lamports; the whole 36 h window (six) would need 432M.
    f.sol.set(authority.toBase58(), 400_000_000)
    await treasuryTick(f.deps(h.db))
    expect(f.alerts.filter(([k]) => k === 'sol-authority')).toHaveLength(0)

    f.sol.set(authority.toBase58(), Number(2n * 5n * LAMPORTS_PER_MARKET) - 1)
    await treasuryTick(f.deps(h.db))
    expect(f.alerts.filter(([k]) => k === 'sol-authority')).toHaveLength(1)
  })

  it('still alerts a low keeper wallet when the Authority read fails, and the other way round', async () => {
    f.sol.set(attestor.publicKey.toBase58(), Number(KEEPER_MIN_LAMPORTS) - 1)
    f.sol.delete(authority.toBase58())
    await treasuryTick(f.deps(h.db))
    expect(f.alerts.map(([k]) => k)).toEqual(['sol-keeper'])
    expect(f.logs.some(([l, m]) => l === 'warn' && m.includes('SOL balance check'))).toBe(true)

    f.alerts.length = 0
    f.sol.set(authority.toBase58(), Number(2n * 4n * LAMPORTS_PER_MARKET) - 1)
    f.sol.delete(attestor.publicKey.toBase58())
    await treasuryTick(f.deps(h.db))
    expect(f.alerts.map(([k]) => k)).toEqual(['sol-authority'])
  })

  it('assumes at least four markets a night, alerts a low keeper wallet and survives faucet and SOL read errors', async () => {
    f.faucetError = new Error('rate limited')
    f.sol.set(authority.toBase58(), Number(2n * 4n * LAMPORTS_PER_MARKET) - 1)
    f.sol.set(attestor.publicKey.toBase58(), Number(KEEPER_MIN_LAMPORTS) - 1)
    await treasuryTick(f.deps(h.db))
    expect(f.alerts.map(([k]) => k)).toEqual(['sol-authority', 'sol-keeper'])
    expect(f.logs.some(([l, m]) => l === 'info' && m === 'faucet skipped')).toBe(true)

    f.alerts.length = 0
    f.sol.set(attestor.publicKey.toBase58(), 1e9)
    f.sol.delete(authority.toBase58())
    await expect(treasuryTick(f.deps(h.db))).resolves.toEqual({ moved: 0n, target: 0n })
    expect(f.alerts).toEqual([])
    expect(f.logs.some(([l, m]) => l === 'warn' && m.includes('SOL balance check'))).toBe(true)
  })
})
