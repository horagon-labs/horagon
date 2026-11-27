// A fake devnet for the Practice tests (R8): the Config account, and one GameMarket per game,
// which the fake sender writes the way the program would for create, halt, propose_result,
// finalize and recycle. The game of a send comes from its label (`create <gameId>`, ...), and its
// market fields from the games row. A helper file, imported by practice-*.test.ts.
import { type Db, getGame } from '@horagon/db'
import { deriveGameMarket, HORAGON_ACCOUNT_DISCRIMINATORS, marketIdFor } from '@horagon/sdk'
import { asciiField, BorshWriter } from '@horagon/sdk/program'
import { type AccountInfo, type Connection, Keypair, PublicKey } from '@solana/web3.js'
import type { SendResult, SendSpec, TxSender } from '../src/executor'
import { account, configBytes, program, proposeArgs, STATUS } from './chain-fixtures'

export { program, STATUS }

export interface MarketFields {
  marketId: bigint
  league: string
  externalId: string
  home: string
  away: string
  tip: number
  endTs: number
  status: number
  outcome?: number
  evidence?: Uint8Array
  uri?: string
  proposedAt?: number
  proposer?: PublicKey
  challenges?: number
  finalizedAt?: number
}

export function marketBytes(m: MarketFields): Buffer {
  return new BorshWriter()
    .fixed(Uint8Array.from(HORAGON_ACCOUNT_DISCRIMINATORS.GameMarket), 8)
    .pubkey(program.addresses(m.marketId).market)
    .u64(m.marketId)
    .u8(0)
    .fixed(asciiField(m.league, 8, 'league'), 8)
    .string(m.externalId, 16)
    .fixed(asciiField(m.home, 4, 'home'), 4)
    .fixed(asciiField(m.away, 4, 'away'), 4)
    .i64(m.tip)
    .i64(m.endTs)
    .u64(300_000_000n)
    .u8(m.status)
    .option<number>(m.outcome ?? null, (w, v) => w.u8(v))
    .fixed(m.evidence ?? new Uint8Array(32), 32)
    .string(m.uri ?? '', 128)
    .i64(m.proposedAt ?? 0)
    .pubkey(m.proposer ?? PublicKey.default)
    .u8(m.challenges ?? 0)
    .i64(m.finalizedAt ?? 0)
    .u8(255)
    .toBuffer()
}

const PROGRAM_VERBS = new Set(['create', 'halt', 'propose', 'finalize', 'recycle'])

export class PracticeChain {
  readonly attestor = Keypair.generate()
  readonly accounts = new Map<string, AccountInfo<Buffer>>()
  readonly markets = new Map<string, MarketFields>()
  readonly specs: SendSpec[] = []
  /** The chain clock (unix seconds); the tests move it with their own clock. */
  clock: number
  /** SOL of every account, in lamports. */
  lamports = 5_000_000_000
  /** mUSDC of every token account, in base units. */
  tokens = 5_000_000_000n

  constructor(
    private readonly db: Db,
    clock: number,
    /** end_ts of a created market, from its tip-off. */
    private readonly endOffsetSecs: number,
  ) {
    this.clock = clock
    this.accounts.set(program.config.toBase58(), account(configBytes(this.attestor.publicKey)))
  }

  get sends(): string[] {
    return this.specs.map((s) => s.label)
  }

  private put(gameId: string, m: MarketFields): void {
    this.markets.set(gameId, m)
    this.accounts.set(
      deriveGameMarket(m.marketId, program.programId).toBase58(),
      account(marketBytes(m)),
    )
  }

  /** The market of a game, as the fake program last wrote it. */
  market(gameId: string): MarketFields | undefined {
    return this.markets.get(gameId)
  }

  /** Sets a market's fields by hand (a challenge, a market from an earlier run). */
  patch(gameId: string, p: Partial<MarketFields>): void {
    const m = this.markets.get(gameId)
    if (!m) throw new Error(`no market for ${gameId}`)
    this.put(gameId, { ...m, ...p })
  }

  readonly connection = {
    getAccountInfo: async (k: PublicKey) => this.accounts.get(k.toBase58()) ?? null,
    getMultipleAccountsInfo: async (ks: PublicKey[]) =>
      ks.map((k) => this.accounts.get(k.toBase58()) ?? null),
    getTokenAccountBalance: async () => ({
      context: { slot: 1 },
      value: {
        amount: this.tokens.toString(),
        decimals: 6,
        uiAmount: Number(this.tokens) / 1e6,
      },
    }),
    getBalance: async () => this.lamports,
    getSlot: async () => 1,
    getBlockTime: async () => this.clock,
    getBlockHeight: async () => 1_000,
    getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [null] }),
  } as unknown as Connection

  readonly sender = {
    connection: this.connection,
    send: async (spec: SendSpec): Promise<SendResult> => {
      this.specs.push(spec)
      const [verb = '', gameId = ''] = spec.label.split(' ')
      const prev = this.markets.get(gameId)
      if (!PROGRAM_VERBS.has(verb)) {
        // Not a program instruction this fake knows (a token transfer): it simply lands.
      } else if (verb === 'create') {
        const g = await getGame(this.db, gameId)
        if (!g) throw new Error(`no game ${gameId}`)
        const tip = Math.floor(g.scheduledTipoff.getTime() / 1000)
        this.put(gameId, {
          marketId: await marketIdFor(g.league, g.externalId, 0),
          league: g.league,
          externalId: g.externalId,
          home: g.home,
          away: g.away,
          tip,
          endTs: tip + this.endOffsetSecs,
          status: STATUS.open,
        })
      } else if (!prev) {
        throw new Error(`${spec.label}: no market on chain`)
      } else if (verb === 'halt') {
        this.put(gameId, { ...prev, status: STATUS.halted })
      } else if (verb === 'propose') {
        if (this.clock < prev.endTs) throw new Error(`${spec.label}: before end_ts`)
        const p = proposeArgs(spec)
        this.put(gameId, {
          ...prev,
          status: STATUS.proposed,
          outcome: p.outcome,
          evidence: p.hash,
          uri: p.uri,
          proposedAt: this.clock,
          proposer: p.signer,
        })
      } else if (verb === 'finalize') {
        this.put(gameId, { ...prev, status: STATUS.finalized, finalizedAt: this.clock })
      } else if (verb === 'recycle') {
        this.put(gameId, { ...prev, status: STATUS.recycled })
      }
      return { signature: `sig${this.specs.length}`, attempts: 1, alreadyDone: false }
    },
  } as unknown as TxSender
}
