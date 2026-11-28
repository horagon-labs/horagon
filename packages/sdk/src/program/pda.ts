import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { HoragonError } from '../errors'
import { sha256 } from '../evidence/hash'
import { METAPLEX_PROGRAM_ID, PM_AMM_PROGRAM_ID } from '../pm-amm/constants'
import {
  deriveLpPosition,
  deriveMarketPda,
  deriveNoMint,
  deriveVault,
  deriveYesMint,
  u64Le,
} from '../pm-amm/pda'
import {
  AUTHORITY_SEED,
  BPF_LOADER_UPGRADEABLE_ID,
  CONFIG_SEED,
  GAME_MARKET_SEED,
  HORAGON_PROGRAM_ID,
  MAX_MARKET_NAME_LEN,
} from './constants'

const utf8 = new TextEncoder()

export function deriveConfig(programId = HORAGON_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([utf8.encode(CONFIG_SEED)], programId)[0]
}

/** The PDA that is `market.authority` of every Horagon market and seeds its pool. */
export function deriveAuthority(programId = HORAGON_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([utf8.encode(AUTHORITY_SEED)], programId)[0]
}

export function deriveGameMarket(marketId: bigint, programId = HORAGON_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(
    [utf8.encode(GAME_MARKET_SEED), u64Le(marketId)],
    programId,
  )[0]
}

export function deriveProgramData(programId = HORAGON_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBytes()], BPF_LOADER_UPGRADEABLE_ID)[0]
}

export function deriveMetadata(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [utf8.encode('metadata'), METAPLEX_PROGRAM_ID.toBytes(), mint.toBytes()],
    METAPLEX_PROGRAM_ID,
  )[0]
}

/** The Authority's mUSDC ATA: the treasury, which also receives the creator half of fees. */
export function deriveTreasury(collateralMint: PublicKey, programId = HORAGON_PROGRAM_ID) {
  return getAssociatedTokenAddressSync(
    collateralMint,
    deriveAuthority(programId),
    true,
    TOKEN_PROGRAM_ID,
  )
}

/** Every address one Horagon market touches, derived from its `market_id`. */
export interface MarketAddresses {
  marketId: bigint
  gameMarket: PublicKey
  market: PublicKey
  yesMint: PublicKey
  noMint: PublicKey
  vault: PublicKey
  yesMetadata: PublicKey
  noMetadata: PublicKey
  lpPosition: PublicKey
  authority: PublicKey
  authorityYes: PublicKey
  authorityNo: PublicKey
}

export function marketAddresses(
  marketId: bigint,
  programId = HORAGON_PROGRAM_ID,
  pmAmmProgramId = PM_AMM_PROGRAM_ID,
): MarketAddresses {
  const authority = deriveAuthority(programId)
  const market = deriveMarketPda(marketId, pmAmmProgramId)
  const yesMint = deriveYesMint(market, pmAmmProgramId)
  const noMint = deriveNoMint(market, pmAmmProgramId)
  return {
    marketId,
    gameMarket: deriveGameMarket(marketId, programId),
    market,
    yesMint,
    noMint,
    vault: deriveVault(market, pmAmmProgramId),
    yesMetadata: deriveMetadata(yesMint),
    noMetadata: deriveMetadata(noMint),
    lpPosition: deriveLpPosition(market, authority, pmAmmProgramId),
    authority,
    authorityYes: getAssociatedTokenAddressSync(yesMint, authority, true, TOKEN_PROGRAM_ID),
    authorityNo: getAssociatedTokenAddressSync(noMint, authority, true, TOKEN_PROGRAM_ID),
  }
}

export type MarketKindCode = 0 | 1

/**
 * A new market id: 8 random bytes from WebCrypto, read as u64 LE (never 0). pm-AMM's
 * `initialize_market` is open to any signer, so an id anyone can compute ahead of time
 * (`marketIdFor`) lets them create its PDA first and block the game. The keeper stores the id it
 * draws (`market_id_reservations`) before sending the create, and every reader takes the id from
 * the database, never from the game.
 */
export function randomMarketId(
  fill: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b),
): bigint {
  for (;;) {
    const bytes = fill(new Uint8Array(8))
    const id = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true)
    if (id !== 0n) return id
  }
}

/**
 * Spec section 5.1, legacy: the first 8 bytes of
 * sha256("horagon:v1:" + league + ":" + external_game_id + ":" + kind), read as u64 LE.
 * `salt` n (1..9) appends ":salt" + n, for when the pm-AMM market PDA is already taken.
 * Every input is public, so anyone can create these PDAs first: new markets use
 * `randomMarketId`. This stays for markets created before it, which keep their stored id.
 */
export async function marketIdFor(
  league: string,
  externalGameId: string,
  kind: MarketKindCode,
  salt = 0,
): Promise<bigint> {
  if (!Number.isInteger(salt) || salt < 0 || salt > 9) {
    throw new HoragonError('INVALID_INPUT', `salt must be 0-9, got ${salt}`)
  }
  const text = `horagon:v1:${league}:${externalGameId}:${kind}${salt === 0 ? '' : `:salt${salt}`}`
  const digest = await sha256(utf8.encode(text))
  return new DataView(digest.buffer).getBigUint64(0, true)
}

/**
 * Spec section 5.1: the Metaplex name, at most 32 chars: `HRG NBA {AWAY}@{HOME} {MMDD} {W|H2}`.
 * `gameDate` is the league's own date for the game (US Eastern for the NBA), `YYYY-MM-DD`.
 */
export function marketName(p: {
  league: string
  away: string
  home: string
  gameDate: string
  kind: MarketKindCode
}): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(p.gameDate)
  if (!m) throw new HoragonError('INVALID_INPUT', `gameDate must be YYYY-MM-DD, got ${p.gameDate}`)
  const name = `HRG ${p.league} ${p.away}@${p.home} ${m[1]}${m[2]} ${p.kind === 0 ? 'W' : 'H2'}`
  if (name.length > MAX_MARKET_NAME_LEN) {
    throw new HoragonError('INVALID_INPUT', `market name too long: ${name}`)
  }
  return name
}
