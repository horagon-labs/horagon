// A fake devnet for the propose core and the keeper's auto-propose: one game (MEM@CLE), its
// GameMarket and Config accounts, a chain clock, and a sender that does what the program would do
// with create, halt, propose_result, finalize and recycle. A file of its own, imported by tests.
import {
  type Db,
  type DraftRow,
  upsertDraft,
  upsertMarket,
  upsertScheduledGames,
} from '@horagon/db'
import {
  DEVNET_MUSDC_MINT,
  deriveGameMarket,
  HORAGON_ACCOUNT_DISCRIMINATORS,
  HoragonProgram,
  marketIdFor,
} from '@horagon/sdk'
import { toHex } from '@horagon/sdk/evidence'
import { asciiField, BorshWriter } from '@horagon/sdk/program'
import { type AccountInfo, type Connection, Keypair, PublicKey } from '@solana/web3.js'
import type { SendResult, SendSpec, TxSender } from '../src/executor'
import { DEFAULT_TIMINGS } from '../src/planner'

export const ID = 'nba-401910007'
export const S = 1_795_000_000
export const END = S + DEFAULT_TIMINGS.endOffsetSecs
export const program = new HoragonProgram({ collateralMint: DEVNET_MUSDC_MINT })
export const STATUS = {
  open: 0,
  halted: 1,
  proposed: 2,
  challenged: 3,
  finalized: 4,
  recycled: 5,
} as const

export const QUARTERS: Array<[number, number]> = [
  [30, 25],
  [28, 27],
  [26, 30],
  [27, 24],
]
export const ESPN_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261118'

export function account(data: Buffer): AccountInfo<Buffer> {
  return { data, owner: program.programId, lamports: 1, executable: false, rentEpoch: 0 }
}

export function configBytes(attestor: PublicKey, windowSecs = 900): Buffer {
  return new BorshWriter()
    .fixed(Uint8Array.from(HORAGON_ACCOUNT_DISCRIMINATORS.Config), 8)
    .pubkey(Keypair.generate().publicKey)
    .pubkey(attestor)
    .pubkey(Keypair.generate().publicKey)
    .pubkey(PublicKey.default)
    .u32(windowSecs)
    .pubkey(DEVNET_MUSDC_MINT)
    .bool(false)
    .u8(255)
    .toBuffer()
}

/** GameMarket fields set by propose, challenge and finalize. */
export interface Settled {
  outcome?: number
  evidence?: Uint8Array
  uri?: string
  proposedAt?: number
  proposer?: PublicKey
  challenges?: number
  finalizedAt?: number
}

/** The game a GameMarket is for: MEM@CLE, NBA, kind 0, at S unless a test says otherwise. */
export interface GameFields {
  kind?: number
  gameId?: string
  league?: string
  home?: string
  away?: string
  tipoff?: number
}

export function gameMarketBytes(
  marketId: bigint,
  status: number,
  x: Settled = {},
  g: GameFields = {},
): Buffer {
  const tipoff = g.tipoff ?? S
  return new BorshWriter()
    .fixed(Uint8Array.from(HORAGON_ACCOUNT_DISCRIMINATORS.GameMarket), 8)
    .pubkey(program.addresses(marketId).market)
    .u64(marketId)
    .u8(g.kind ?? 0)
    .fixed(asciiField(g.league ?? 'NBA', 8, 'league'), 8)
    .string(g.gameId ?? '401910007', 16)
    .fixed(asciiField(g.home ?? 'CLE', 4, 'home'), 4)
    .fixed(asciiField(g.away ?? 'MEM', 4, 'away'), 4)
    .i64(tipoff)
    .i64(tipoff + DEFAULT_TIMINGS.endOffsetSecs)
    .u64(300_000_000n)
    .u8(status)
    .option<number>(x.outcome ?? null, (w, v) => w.u8(v))
    .fixed(x.evidence ?? new Uint8Array(32), 32)
    .string(x.uri ?? '', 128)
    .i64(x.proposedAt ?? 0)
    .pubkey(x.proposer ?? PublicKey.default)
    .u8(x.challenges ?? 0)
    .i64(x.finalizedAt ?? 0)
    .u8(255)
    .toBuffer()
}

/** What a `propose_result` instruction carries (its data: discriminator, outcome, hash, URI). */
export function proposeArgs(spec: SendSpec): {
  signer: PublicKey
  signed: boolean
  outcome: number
  hash: Uint8Array
  uri: string
} {
  const ix = spec.instructions.at(-1)
  if (!ix) throw new Error(`${spec.label}: no instruction`)
  const data = ix.data
  const len = data.readUInt32LE(41)
  const key = ix.keys[0]
  if (!key) throw new Error(`${spec.label}: no signer account`)
  return {
    signer: key.pubkey,
    signed: key.isSigner,
    outcome: data[8] ?? -1,
    hash: Uint8Array.from(data.subarray(9, 41)),
    uri: data.subarray(45, 45 + len).toString('utf8'),
  }
}

/**
 * The chain: accounts by address, a clock (unix seconds) and a block height. The sender applies
 * create, halt, propose, finalize and recycle the way the program would; `fail` makes it throw
 * for a label instead.
 */
export class FakeChain {
  readonly accounts = new Map<string, AccountInfo<Buffer>>()
  readonly specs: SendSpec[] = []
  /** isDone answers found wrong: done before the send, or not done after it. */
  readonly doneProblems: string[] = []
  settled: Settled = {}
  clock: number
  height = 1_000
  fail: ((label: string) => Error | undefined) | undefined
  readonly gm: string

  constructor(
    readonly marketId: bigint,
    readonly attestor: PublicKey,
    clock: number,
  ) {
    this.clock = clock
    this.gm = deriveGameMarket(marketId, program.programId).toBase58()
    this.accounts.set(program.config.toBase58(), account(configBytes(attestor)))
  }

  setMarket(status: number, x: Settled = this.settled): void {
    this.settled = x
    this.accounts.set(this.gm, account(gameMarketBytes(this.marketId, status, x)))
  }

  get sends(): string[] {
    return this.specs.map((s) => s.label)
  }

  readonly connection = {
    getAccountInfo: async (k: PublicKey) => this.accounts.get(k.toBase58()) ?? null,
    getMultipleAccountsInfo: async (ks: PublicKey[]) =>
      ks.map((k) => this.accounts.get(k.toBase58()) ?? null),
    getTokenAccountBalance: async () => ({
      context: { slot: 1 },
      value: { amount: '5000000000', decimals: 6, uiAmount: 5000 },
    }),
    getSlot: async () => 1,
    getBlockTime: async () => this.clock,
    getBlockHeight: async () => this.height,
    getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [null] }),
  } as unknown as Connection

  readonly sender = {
    connection: this.connection,
    send: async (spec: SendSpec): Promise<SendResult> => {
      this.specs.push(spec)
      if (await spec.isDone?.()) this.doneProblems.push(`${spec.label}: done before it was sent`)
      const failure = this.fail?.(spec.label)
      if (failure) throw failure
      if (spec.label.startsWith('create')) this.setMarket(STATUS.open, {})
      if (spec.label.startsWith('halt')) this.setMarket(STATUS.halted)
      if (spec.label.startsWith('propose')) {
        const p = proposeArgs(spec)
        this.setMarket(STATUS.proposed, {
          ...this.settled,
          outcome: p.outcome,
          evidence: p.hash,
          uri: p.uri,
          proposedAt: this.clock,
          proposer: p.signer,
        })
      }
      if (spec.label.startsWith('finalize'))
        this.setMarket(STATUS.finalized, { ...this.settled, finalizedAt: this.clock })
      if (spec.label.startsWith('recycle')) this.setMarket(STATUS.recycled)
      if (!(await spec.isDone?.()))
        this.doneProblems.push(`${spec.label}: not done after it landed`)
      return { signature: `sig${this.specs.length}`, attempts: 1, alreadyDone: false }
    },
  } as unknown as TxSender
}

/** The hex of the evidence hash a GameMarket account holds. */
export const chainHash = (c: FakeChain): string => toHex(c.settled.evidence ?? new Uint8Array(32))

/** The game row, as the hourly schedule writes it. */
export async function seedGame(db: Db): Promise<void> {
  await upsertScheduledGames(db, [
    {
      id: ID,
      league: 'NBA',
      externalId: '401910007',
      gameDate: '2026-11-18',
      home: 'CLE',
      away: 'MEM',
      scheduledTipoff: new Date(S * 1000),
      status: 'scheduled',
      p0: 0.62,
    },
  ])
}

/** The winner market's row, as the keeper's create records it. */
export async function seedMarket(db: Db, status = 'halted'): Promise<bigint> {
  const marketId = await marketIdFor('NBA', '401910007', 0)
  const a = program.addresses(marketId)
  await upsertMarket(db, {
    pubkey: a.market.toBase58(),
    gameId: ID,
    kind: 0,
    marketId: marketId.toString(),
    gameMarketPda: a.gameMarket.toBase58(),
    yesMint: a.yesMint.toBase58(),
    noMint: a.noMint.toBase58(),
    initialPriceBps: 6_200,
    endTs: new Date(END * 1000),
    seedAmount: 300_000_000n,
    status,
  })
  return marketId
}

/** The keeper's Final draft, 111-106 (home-away), first seen at END - 900. */
export const DRAFT: Omit<DraftRow, 'state' | 'alertedAt' | 'createdAt'> = {
  gameId: ID,
  status: 'final',
  homeScore: 111,
  awayScore: 106,
  periods: QUARTERS,
  sourceUrl: ESPN_URL,
  fetchedAt: new Date((END - 900) * 1000),
}

export async function seedDraft(db: Db): Promise<void> {
  await upsertDraft(db, DRAFT)
}
