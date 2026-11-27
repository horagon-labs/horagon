// Test doubles for the API: an in-memory "chain" (just the RPC methods the API calls), a
// PGlite DB seeded with one game and the market recorded in spike S1, and ApiDeps around them.

import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { type DbHandle, upsertMarket, upsertScheduledGames } from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import {
  ataAddress,
  DEVNET_MUSDC_MINT,
  decodeMarket,
  deriveMarketPda,
  HoragonProgram,
  PM_AMM_PROGRAM_ID,
} from '@horagon/sdk'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  type AccountInfo,
  type Connection,
  Keypair,
  type PublicKey,
  type SignatureStatus,
} from '@solana/web3.js'
import pino from 'pino'
import type { ApiDeps, FaucetClient } from '../src/deps'

interface SwapFixture {
  direction: string
  amountIn: string
  actualOut: string
  now: number
  marketDataBase64: string
}

export const S1 = JSON.parse(
  readFileSync(new URL('../../sdk/test/fixtures/s1-swaps.json', import.meta.url), 'utf8'),
) as { swaps: SwapFixture[] }

export const program = new HoragonProgram({ collateralMint: DEVNET_MUSDC_MINT })

export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
/** What a failing fake RPC call throws: a keyed URL that must never reach a client or a log. */
export const RPC_FAILURE = 'fetch failed: https://secret-rpc.example/?api-key=XYZ'

/** The S1 market account as of its first swap, re-pointed at Horagon's Authority PDA. */
export function s1Market(index = 0) {
  const swap = S1.swaps[index]
  if (!swap) throw new Error('no swap')
  const data = Buffer.from(swap.marketDataBase64, 'base64')
  data.set(program.authority.toBytes(), 8)
  const decoded = decodeMarket(data)
  return { swap, data, decoded, pubkey: deriveMarketPda(decoded.marketId) }
}

export function tokenAccount(
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint,
): AccountInfo<Buffer> {
  const data = Buffer.alloc(165)
  data.set(mint.toBytes(), 0)
  data.set(owner.toBytes(), 32)
  data.writeBigUInt64LE(amount, 64)
  data[108] = 1 // initialized
  return { data, owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, executable: false, rentEpoch: 0 }
}

/** Only the RPC methods the API uses; each records its calls. */
export class FakeChain {
  accounts = new Map<string, AccountInfo<Buffer>>()
  statuses = new Map<string, SignatureStatus>()
  simulateErr: unknown = null
  simulateLogs: string[] = []
  simulateFails = false
  sendFails = false
  /** getAccountInfo and getMultipleAccountsInfo throw. */
  accountsFail = false
  genesisHash = DEVNET_GENESIS_HASH
  genesisFails = false
  genesisCalls = 0
  sent: Buffer[] = []
  simulated = 0

  set(key: PublicKey, info: AccountInfo<Buffer>) {
    this.accounts.set(key.toBase58(), info)
  }

  asConnection(): Connection {
    const self = this
    return {
      async getAccountInfo(k: PublicKey) {
        if (self.accountsFail) throw new Error(RPC_FAILURE)
        return self.accounts.get(k.toBase58()) ?? null
      },
      async getMultipleAccountsInfo(ks: PublicKey[]) {
        if (self.accountsFail) throw new Error(RPC_FAILURE)
        return ks.map((k) => self.accounts.get(k.toBase58()) ?? null)
      },
      async getLatestBlockhash() {
        return {
          blockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N',
          lastValidBlockHeight: 100,
        }
      },
      async getSignatureStatuses(sigs: string[]) {
        return { context: { slot: 1 }, value: sigs.map((s) => self.statuses.get(s) ?? null) }
      },
      async getGenesisHash() {
        self.genesisCalls++
        if (self.genesisFails) throw new Error(RPC_FAILURE)
        return self.genesisHash
      },
      async simulateTransaction() {
        if (self.simulateFails) throw new Error(RPC_FAILURE)
        self.simulated++
        return { context: { slot: 1 }, value: { err: self.simulateErr, logs: self.simulateLogs } }
      },
      async sendRawTransaction(raw: Uint8Array) {
        if (self.sendFails) throw new Error(RPC_FAILURE)
        self.sent.push(Buffer.from(raw))
        return 'sent'
      },
      async getMinimumBalanceForRentExemption() {
        return 2_039_280
      },
      async getSlot() {
        return 123
      },
    } as unknown as Connection
  }
}

export const GAME_ID = 'nba-401910007'

export async function seed(
  h: DbHandle,
  marketKey: PublicKey,
  m: ReturnType<typeof s1Market>['decoded'],
) {
  await upsertScheduledGames(h.db, [
    {
      id: GAME_ID,
      league: 'NBA',
      externalId: '401910007',
      gameDate: '2026-11-19',
      home: 'LAL',
      away: 'BOS',
      scheduledTipoff: new Date('2026-11-20T03:30:00Z'),
      status: 'scheduled',
      p0: 0.61,
    },
  ])
  await upsertMarket(h.db, {
    pubkey: marketKey.toBase58(),
    gameId: GAME_ID,
    kind: 0,
    marketId: m.marketId.toString(),
    gameMarketPda: program.addresses(m.marketId).gameMarket.toBase58(),
    yesMint: m.yesMint.toBase58(),
    noMint: m.noMint.toBase58(),
    initialPriceBps: 6100,
    endTs: new Date(m.endTs * 1000),
    seedAmount: 1_000_000_000n,
    status: 'open',
  })
}

export interface TestEnv {
  h: DbHandle
  chain: FakeChain
  deps: ApiDeps
  sponsor: Keypair
  user: Keypair
  market: ReturnType<typeof s1Market>
  faucetCalls: string[]
  logs: string[]
}

export async function makeEnv(
  opts: {
    txPerHour?: number
    capSol?: number
    /** The slice of the cap only wallets with a landed sponsored trade may spend (default 0). */
    reserveSol?: number
    atasPerWalletDay?: number
    atasPerIpDay?: number
  } = {},
): Promise<TestEnv> {
  const h = await createTestDb()
  const chain = new FakeChain()
  const market = s1Market(0)
  chain.set(market.pubkey, {
    data: market.data,
    owner: PM_AMM_PROGRAM_ID,
    lamports: 1,
    executable: false,
    rentEpoch: 0,
  })
  await seed(h, market.pubkey, market.decoded)
  const sponsor = Keypair.generate()
  const user = Keypair.generate()
  chain.set(
    ataAddress({ owner: user.publicKey, mint: DEVNET_MUSDC_MINT }),
    tokenAccount(DEVNET_MUSDC_MINT, user.publicKey, 1_000_000_000n),
  )
  const faucetCalls: string[] = []
  /** Every log line the API wrote, as JSON text. */
  const logs: string[] = []
  const faucet: FaucetClient = async (wallet) => {
    faucetCalls.push(wallet)
    return { signature: null, amount: 1000 }
  }
  const deps: ApiDeps = {
    db: h.db,
    connection: chain.asConnection(),
    cluster: 'devnet',
    program,
    collateralMint: DEVNET_MUSDC_MINT,
    sponsor: {
      keypair: sponsor,
      dailyCapLamports: BigInt(Math.round((opts.capSol ?? 2) * 1e9)),
      reserveLamports: BigInt(Math.round((opts.reserveSol ?? 0) * 1e9)),
      txPerHour: opts.txPerHour ?? 30,
      atasPerDay: { wallet: opts.atasPerWalletDay ?? 26, ip: opts.atasPerIpDay ?? 78 },
    },
    faucet,
    publicUrl: 'https://horagon.test',
    ipSalt: 'salt',
    version: 'test',
    log: pino({ level: 'info' }, { write: (line: string) => void logs.push(line) }),
    now: () => market.swap.now,
  }
  return { h, chain, deps, sponsor, user, market, faucetCalls, logs }
}
