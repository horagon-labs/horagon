import type { PublicKey } from '@solana/web3.js'
import { HoragonError } from '../errors'
import type { Outcome } from '../schemas'
import { BorshReader, readAsciiField } from './borsh'
import { HORAGON_PROGRAM_ID } from './constants'

/** sha256("account:<Name>")[0..8]. */
export const HORAGON_ACCOUNT_DISCRIMINATORS = {
  Config: [155, 12, 170, 224, 30, 250, 204, 130],
  GameMarket: [35, 41, 40, 135, 35, 216, 218, 90],
} as const

/** On-chain `MarketStatus`, Borsh variant order. */
export const GAME_MARKET_STATUSES = [
  'open',
  'halted',
  'proposed',
  'challenged',
  'finalized',
  'recycled',
] as const
export type GameMarketStatus = (typeof GAME_MARKET_STATUSES)[number]

const OUTCOMES: readonly Outcome[] = ['yes', 'no']

/** Borsh `Outcome` byte, validated. */
export function readOutcome(r: BorshReader): Outcome {
  const o = OUTCOMES[r.u8()]
  if (!o) throw new HoragonError('INVALID_INPUT', 'unknown outcome')
  return o
}

/** Borsh market `kind` byte, validated. */
export function readMarketKind(r: BorshReader): 0 | 1 {
  const kind = r.u8()
  if (kind > 1) throw new HoragonError('INVALID_INPUT', `unknown market kind ${kind}`)
  return kind as 0 | 1
}

export interface ConfigAccount {
  admin: PublicKey
  attestor: PublicKey
  guardians: [PublicKey, PublicKey]
  disputeWindowSecs: number
  collateralMint: PublicKey
  creationPaused: boolean
  bump: number
}

export interface GameMarketAccount {
  market: PublicKey
  marketId: bigint
  kind: 0 | 1
  league: string
  externalGameId: string
  home: string
  away: string
  scheduledTipoff: number
  endTs: number
  seedAmount: bigint
  status: GameMarketStatus
  proposedOutcome: Outcome | null
  /** 32 bytes; all zero until proposed. */
  evidenceHash: Uint8Array
  evidenceUri: string
  proposedAt: number
  proposer: PublicKey
  challengeCount: number
  finalizedAt: number
  bump: number
}

interface AccountInfoLike {
  owner: PublicKey
  data: Uint8Array
}

function reader(
  info: AccountInfoLike,
  name: keyof typeof HORAGON_ACCOUNT_DISCRIMINATORS,
  programId: PublicKey,
): BorshReader {
  if (!info.owner.equals(programId)) {
    throw new HoragonError('NOT_FOUND', `account is not owned by the horagon program`)
  }
  const disc = HORAGON_ACCOUNT_DISCRIMINATORS[name]
  if (info.data.length < 8 || !disc.every((b, i) => info.data[i] === b)) {
    throw new HoragonError('INVALID_INPUT', `account is not a ${name}`)
  }
  const r = new BorshReader(info.data)
  r.fixed(8)
  return r
}

const seconds = (v: bigint) => Number(v)

export function decodeConfig(info: AccountInfoLike, programId = HORAGON_PROGRAM_ID): ConfigAccount {
  const r = reader(info, 'Config', programId)
  return {
    admin: r.pubkey(),
    attestor: r.pubkey(),
    guardians: [r.pubkey(), r.pubkey()],
    disputeWindowSecs: r.u32(),
    collateralMint: r.pubkey(),
    creationPaused: r.bool(),
    bump: r.u8(),
  }
}

export function decodeGameMarket(
  info: AccountInfoLike,
  programId = HORAGON_PROGRAM_ID,
): GameMarketAccount {
  const r = reader(info, 'GameMarket', programId)
  const market = r.pubkey()
  const marketId = r.u64()
  const kind = readMarketKind(r)
  const league = readAsciiField(r.fixed(8))
  const externalGameId = r.string()
  const home = readAsciiField(r.fixed(4))
  const away = readAsciiField(r.fixed(4))
  const scheduledTipoff = seconds(r.i64())
  const endTs = seconds(r.i64())
  const seedAmount = r.u64()
  const statusIndex = r.u8()
  const status = GAME_MARKET_STATUSES[statusIndex]
  if (!status) throw new HoragonError('INVALID_INPUT', `unknown market status ${statusIndex}`)
  const proposedOutcome = r.option(readOutcome)
  return {
    market,
    marketId,
    kind,
    league,
    externalGameId,
    home,
    away,
    scheduledTipoff,
    endTs,
    seedAmount,
    status,
    proposedOutcome,
    evidenceHash: r.fixed(32),
    evidenceUri: r.string(),
    proposedAt: seconds(r.i64()),
    proposer: r.pubkey(),
    challengeCount: r.u8(),
    finalizedAt: seconds(r.i64()),
    bump: r.u8(),
  }
}

/** Byte offset of `market` in GameMarket, for getProgramAccounts memcmp filters. */
export const GAME_MARKET_MARKET_OFFSET = 8
