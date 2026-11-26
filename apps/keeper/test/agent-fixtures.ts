// Test doubles for the reference agent: pools at a chosen price, pm-AMM Market account bytes in
// the program's layout (the inverse of the SDK's `decodeMarket`), SPL token accounts, a fake
// chain with the RPC methods the agent reads, a fake sender, and a live market seeded in the
// keeper's database and on the fake chain.
import { type Db, updateGameLive, upsertMarket, upsertScheduledGames } from '@horagon/db'
import {
  DEVNET_MUSDC_MINT,
  decodeMarketAccount,
  deriveMarketPda,
  deriveNoMint,
  deriveVault,
  deriveYesMint,
  HoragonProgram,
  MARKET_ACCOUNT_SPACE,
  MARKET_DISCRIMINATOR,
  PM_AMM_PROGRAM_ID,
  type PoolState,
} from '@horagon/sdk'
import { lEffective, reservesFromPrice } from '@horagon/sdk/math'
import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  type AccountInfo,
  type Connection,
  PublicKey,
  type VersionedTransaction,
  VersionedTransaction as VTx,
} from '@solana/web3.js'
import { DEVNET_GENESIS_HASH } from '../src/config'
import type { SendSpec } from '../src/executor'

/** Seconds between a market's creation and its end_ts (created 1 h before S, ends S + 3 h). */
export const CREATED_SECS = 14_400

/** L_0 of a market seeded with `seed` mUSDC at `price`, CREATED_SECS before its end. */
export function lZeroFor(seed: number, price: number): number {
  const unit = reservesFromPrice(price, 1)
  return (seed * 1e6) / Math.max(unit.x, unit.y) / Math.sqrt(CREATED_SECS)
}

/** A pool priced at `price` at `now`, `remaining` seconds before its end. */
export function poolAt(
  price: number,
  o: { now: number; remaining?: number; seed?: number; lZero?: number },
): PoolState {
  const remaining = o.remaining ?? 4_200
  const lZero = o.lZero ?? lZeroFor(o.seed ?? 300, 0.6)
  const r = reservesFromPrice(price, lEffective(lZero, remaining))
  return {
    lZero,
    reserveYes: r.x,
    reserveNo: r.y,
    lastAccrualTs: o.now,
    endTs: o.now + remaining,
    hasLiquidity: true,
    resolved: false,
  }
}

const I80F48_ONE = 2 ** 48
const toI80f48 = (v: number) => BigInt(Math.round(v * I80F48_ONE))

export interface MarketFields {
  marketId: bigint
  authority: PublicKey
  collateralMint?: PublicKey
  pool: PoolState
  resolved?: boolean
  winningSide?: number
}

/** pm-AMM `Market` account bytes (443), field by field in the IDL order. */
export function marketBytes(f: MarketFields): Buffer {
  const data = Buffer.alloc(MARKET_ACCOUNT_SPACE)
  data.set(MARKET_DISCRIMINATOR, 0)
  let o = 8
  const key = (k: PublicKey) => {
    data.set(k.toBytes(), o)
    o += 32
  }
  const u64 = (v: bigint) => {
    data.writeBigUInt64LE(v, o)
    o += 8
  }
  const i64 = (v: number) => {
    data.writeBigInt64LE(BigInt(v), o)
    o += 8
  }
  const u128 = (v: bigint) => {
    u64(v & (2n ** 64n - 1n))
    u64(v >> 64n)
  }
  const u8 = (v: number) => {
    data.writeUInt8(v, o)
    o += 1
  }
  const market = deriveMarketPda(f.marketId)
  key(f.authority)
  u64(f.marketId)
  key(f.collateralMint ?? DEVNET_MUSDC_MINT)
  key(deriveYesMint(market))
  key(deriveNoMint(market))
  key(deriveVault(market))
  i64(f.pool.endTs - CREATED_SECS)
  i64(f.pool.endTs)
  u128(toI80f48(f.pool.lZero))
  u128(toI80f48(f.pool.reserveYes))
  u128(toI80f48(f.pool.reserveNo))
  i64(f.pool.lastAccrualTs)
  u128(0n)
  u128(0n)
  u64(0n)
  u64(0n)
  u128(f.pool.hasLiquidity ? 10n ** 21n : 0n)
  u8(f.resolved ? 1 : 0)
  u8(f.winningSide ?? 0)
  u8(255)
  data.write('agent test market', o, 'utf8')
  o += 64
  data.writeUInt16LE(6_000, o)
  return data
}

export function marketInfo(f: MarketFields): AccountInfo<Buffer> {
  return {
    data: marketBytes(f),
    owner: PM_AMM_PROGRAM_ID,
    lamports: 4_000_000,
    executable: false,
    rentEpoch: 0,
  }
}

export function tokenInfo(mint: PublicKey, owner: PublicKey, amount: bigint): AccountInfo<Buffer> {
  const data = Buffer.alloc(AccountLayout.span)
  AccountLayout.encode(
    {
      mint,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  )
  return { data, owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, executable: false, rentEpoch: 0 }
}

/** The RPC reads of the agent, from maps a test sets. */
export class FakeChain {
  accounts = new Map<string, AccountInfo<Buffer>>()
  lamports = 1_000_000_000
  /** Raw mUSDC of the agent's ATA; null: the account does not exist. */
  musdc: bigint | null = 5_000_000_000n
  fail: { balance?: Error; accounts?: Error } = {}
  reads = 0

  set(key: PublicKey, info: AccountInfo<Buffer> | null): void {
    if (info) this.accounts.set(key.toBase58(), info)
    else this.accounts.delete(key.toBase58())
  }

  /** The pm-AMM market account at `pool`. */
  setMarket(f: MarketFields): PublicKey {
    const key = deriveMarketPda(f.marketId)
    this.set(key, marketInfo(f))
    return key
  }

  asConnection(): Connection {
    const self = this
    return {
      async getMultipleAccountsInfo(keys: PublicKey[]) {
        self.reads++
        if (self.fail.accounts) throw self.fail.accounts
        return keys.map((k) => self.accounts.get(k.toBase58()) ?? null)
      },
      async getBalance() {
        if (self.fail.balance) throw self.fail.balance
        return self.lamports
      },
      async getTokenAccountBalance() {
        if (self.musdc === null)
          throw new Error('failed to get token account balance: could not find account')
        return {
          context: { slot: 1 },
          value: { amount: self.musdc.toString(), decimals: 6, uiAmount: null },
        }
      },
    } as unknown as Connection
  }
}

/** Records every send; `fail` makes the next sends throw it. */
export class FakeSender {
  specs: SendSpec[] = []
  fail: Error | null = null
  /** Runs after a send that "landed" (move the fake market's price here). */
  onSend: ((spec: SendSpec) => void) | null = null

  constructor(readonly connection: Connection) {}

  async send(
    spec: SendSpec,
  ): Promise<{ signature: string | null; attempts: number; alreadyDone: boolean }> {
    this.specs.push(spec)
    if (this.fail) throw this.fail
    this.onSend?.(spec)
    return { signature: `sig${this.specs.length}`, attempts: 1, alreadyDone: false }
  }
}

/** The decoded pool of a fake market, as the agent sees it. */
export const poolOf = (info: AccountInfo<Buffer>) => decodeMarketAccount(info)

const BLOCKHASH = 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N'

/**
 * A devnet RPC, for the keeper's TxSender, that accepts every transaction and keeps the bytes
 * it was sent.
 */
export function recordingConnection(): { conn: Connection; sent: VersionedTransaction[] } {
  const sent: VersionedTransaction[] = []
  const conn = {
    async getGenesisHash() {
      return DEVNET_GENESIS_HASH
    },
    async getLatestBlockhash() {
      return { blockhash: BLOCKHASH, lastValidBlockHeight: 10 }
    },
    async simulateTransaction() {
      return { context: { slot: 1 }, value: { err: null, logs: [] } }
    },
    async sendRawTransaction(raw: Uint8Array) {
      sent.push(VTx.deserialize(raw))
      return `sig${sent.length}`
    },
    async confirmTransaction() {
      return { context: { slot: 1 }, value: { err: null } }
    },
    async getBlockHeight() {
      return 1
    },
    async getSignatureStatuses(sigs: string[]) {
      return { context: { slot: 1 }, value: sigs.map(() => null) }
    },
  }
  return { conn: conn as unknown as Connection, sent }
}

/** The keeper's tick writing the game's model, from a feed read at `at` (Unix seconds). */
export async function writeModel(
  db: Db,
  gameId: string,
  modelProb: number,
  at: number,
  status = 'live',
): Promise<void> {
  await updateGameLive(db, gameId, {
    status,
    homeScore: 50,
    awayScore: 45,
    period: 3,
    clockSecs: 300,
    periods: [],
    modelProb,
    feedUpdatedAt: new Date(at * 1000),
  })
}

export interface SeededMarket {
  key: PublicKey
  fields: MarketFields
  gameId: string
}

/**
 * A live game `nba-<n>` (tipped off 1 h before `now`, model `model` read at `modelAt`) with its
 * open winner market in the keeper's database, ending 4,200 s after `now`, and the market account
 * on `chain` at `price`.
 */
export async function seedLiveMarket(
  db: Db,
  chain: FakeChain,
  n: number,
  o: {
    now: number
    modelAt: number
    price?: number
    model?: number
    seed?: number
    league?: string
  },
): Promise<SeededMarket> {
  const gameId = `nba-${n}`
  await upsertScheduledGames(db, [
    {
      id: gameId,
      league: o.league ?? 'NBA',
      externalId: String(n),
      gameDate: '2026-11-26',
      home: 'CLE',
      away: 'MEM',
      scheduledTipoff: new Date((o.now - 3_600) * 1000),
      status: 'scheduled',
      p0: 0.6,
    },
  ])
  await writeModel(db, gameId, o.model ?? 0.7, o.modelAt)
  const fields: MarketFields = {
    marketId: BigInt(n),
    authority: new HoragonProgram({ collateralMint: DEVNET_MUSDC_MINT }).authority,
    pool: poolAt(o.price ?? 0.6, { now: o.now, remaining: 4_200, seed: o.seed ?? 300 }),
  }
  const key = chain.setMarket(fields)
  await upsertMarket(db, {
    pubkey: key.toBase58(),
    gameId,
    kind: 0,
    marketId: String(n),
    gameMarketPda: `gm-${n}`,
    yesMint: deriveYesMint(key).toBase58(),
    noMint: deriveNoMint(key).toBase58(),
    initialPriceBps: 6_000,
    endTs: new Date((o.now + 4_200) * 1000),
    seedAmount: BigInt(o.seed ?? 300) * 1_000_000n,
    status: 'open',
  })
  return { key, fields, gameId }
}
