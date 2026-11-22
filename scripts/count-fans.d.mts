// Types of scripts/count-fans.mjs, so that packages/sdk/test/metrics/ typechecks under strict mode
// without allowJs. Keep it in step with the script.

export const HORAGON_PROGRAM_ID: string
export const PM_AMM_PROGRAM_ID: string
export const MEMO_PROGRAM_ID: string
/** 8 bytes. */
export const GAME_MARKET_DISCRIMINATOR: Uint8Array
/** 8 bytes. */
export const SWAP_DISCRIMINATOR: Uint8Array
export const BOT_MEMO: 'horagon:bot'
export const WINDOW: { readonly first: '2026-11-23'; readonly last: '2026-12-04' }
export const BOT_RATE: { readonly swaps: 20; readonly seconds: 300 }
export const DEFAULT_RPC: 'https://api.devnet.solana.com'

export function base58Encode(bytes: Uint8Array): string
/** Throws on a character outside the base58 digits. */
export function base58Decode(text: string): Uint8Array

export interface GameMarketInfo {
  /** The pm-AMM market pubkey. */
  market: string
  kind: number
  league: string
  gameId: string
  /** Unix seconds. */
  scheduledTipoff: number
}
/** Throws on a wrong discriminator or short data. */
export function decodeGameMarket(data: Uint8Array): GameMarketInfo
export interface GameMarketRecord extends GameMarketInfo {
  /** The GameMarket account address. */
  address: string
}
/** The ET (America/New_York) date of a unix time, 'YYYY-MM-DD'. */
export function etNight(unixSeconds: number): string
export function inWindow(night: string): boolean

/** One instruction of a raw transaction, top-level or inner. */
export interface RawInstruction {
  programIdIndex: number
  accounts: number[]
  /** Base58. */
  data: string
  stackHeight?: number | null
}
/** A raw `getTransaction` result (encoding `json`, maxSupportedTransactionVersion 0). */
export interface RawTransaction {
  slot?: number
  blockTime: number | null
  version?: 'legacy' | 0
  meta: {
    err: unknown
    loadedAddresses?: { writable: string[]; readonly: string[] }
    innerInstructions?: { index: number; instructions: RawInstruction[] }[] | null
  } | null
  transaction: {
    signatures: string[]
    message: {
      header: {
        numRequiredSignatures: number
        numReadonlySignedAccounts?: number
        numReadonlyUnsignedAccounts?: number
      }
      accountKeys: string[]
      instructions: RawInstruction[]
      addressTableLookups?: {
        accountKey: string
        writableIndexes: number[]
        readonlyIndexes: number[]
      }[]
    }
  }
}
export interface Swap {
  signature: string
  /** The signer in the swap's accounts[0], never the sponsor that pays the fee. */
  wallet: string
  /** The pm-AMM market pubkey. */
  market: string
  blockTime: number
  /** The transaction carries the top-level `horagon:bot` memo. */
  botMemo: boolean
}
export function hasBotMemo(tx: RawTransaction): boolean
/** `markets` holds pm-AMM market pubkeys. One Swap per top-level swap instruction. */
export function extractSwaps(tx: RawTransaction, markets: ReadonlySet<string>): Swap[]

export type TeamRole =
  | 'deployer'
  | 'creator'
  | 'sponsor'
  | 'attestor'
  | 'guardian-1'
  | 'guardian-2'
  | 'treasury'
  | 'squads-member'
  | 'team-burner'
  | 'spike'
export interface TeamWallet {
  pubkey: string
  role: TeamRole
  /** UTC: 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SSZ'. */
  addedAt: string
}
export interface ExcludedMarket {
  /** The GameMarket account address. */
  gameMarket: string
  reason: string
  createSignature: string
  /** UTC: 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM:SSZ'. */
  addedAt: string
}
export interface WalletsFile {
  version: 1
  teamWallets: TeamWallet[]
  excludedMarkets: ExcludedMarket[]
}
export function validateWalletsFile(
  json: unknown,
): { ok: true; value: WalletsFile } | { ok: false; errors: string[] }
/** [] when `next` only appends to `previous`; one error per removed or changed entry otherwise. */
export function checkAppendOnly(previous: WalletsFile, next: WalletsFile): string[]

export function isRateBot(blockTimes: readonly number[]): boolean
export type WalletClass = 'human' | 'bot' | 'team'
export interface ClassStats {
  /** Wallets with at least one swap on a counted market, any night. */
  wallets: number
  firstTrade: number
  returning: number
  threeNightFans: number
  engaged: number
}
export interface FanReport {
  window: { first: string; last: string }
  /** ignored = Horagon GameMarkets neither counted nor excluded (kind 1, non-NBA). */
  markets: { counted: number; excluded: number; ignored: number }
  swaps: { counted: number; nightTouches: number }
  classes: Record<WalletClass, ClassStats>
  /** Wallets per bot reason; a wallet matching both counts once in each. */
  bots: { memo: number; rate: number }
  /**
   * Every night of the window, in order. human, bot and team count the distinct wallets with a
   * night touch that night; touches counts the night touches (swaps) that night, per class.
   */
  nights: {
    night: string
    human: number
    bot: number
    team: number
    touches: { human: number; bot: number; team: number }
  }[]
  excluded: { gameMarket: string; reason: string; nonTeamSwaps: number }[]
  /** = classes.human.threeNightFans */
  threeNightFans: number
}
/** Counts every Swap it is given: deduplicate transactions by signature before extracting. */
export function countFans(input: {
  markets: readonly GameMarketRecord[]
  swaps: readonly Swap[]
  wallets: WalletsFile
}): FanReport
/** Human-readable, without a trailing newline; the last line is 'elapsed: <s.s> s'. */
export function formatReport(report: FanReport, meta: { rpc: string; elapsedMs: number }): string

// RPC and CLI: Task A2 adds the declarations of createRpc, fetchGameMarkets, fetchSignatures,
// fetchSwaps and main below this line.
