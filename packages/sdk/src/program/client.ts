import type { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js'
import { Buffer } from 'buffer'
import { HoragonError } from '../errors'
import { PM_AMM_PROGRAM_ID } from '../pm-amm/constants'
import {
  type ConfigAccount,
  decodeConfig,
  decodeGameMarket,
  type GameMarketAccount,
  HORAGON_ACCOUNT_DISCRIMINATORS,
} from './accounts'
import { HORAGON_PROGRAM_ID } from './constants'
import {
  authorityOutcomeAtaIxs,
  buildChallengeIx,
  buildCreateGameMarketIx,
  buildFinalizeIx,
  buildHaltIx,
  buildInitializeConfigIx,
  buildProposeResultIx,
  buildRecycleIx,
  buildUpdateConfigIx,
  buildWithdrawTreasuryIx,
  type ChallengeParams,
  type CreateGameMarketParams,
  type HaltParams,
  type InitializeConfigParams,
  type MarketIxParams,
  type ProposeResultParams,
  type RecycleParams,
  type UpdateConfigParams,
  type WithdrawTreasuryParams,
} from './instructions'
import {
  deriveAuthority,
  deriveConfig,
  deriveGameMarket,
  deriveTreasury,
  type MarketAddresses,
  marketAddresses,
} from './pda'

type Bound<T> = Omit<T, 'programId' | 'pmAmmProgramId' | 'collateralMint'>

export interface HoragonProgramOptions {
  collateralMint: PublicKey
  programId?: PublicKey
  pmAmmProgramId?: PublicKey
}

/**
 * The `horagon` program bound to one deployment (program id, pm-AMM id, collateral mint):
 * derives addresses, builds instructions and reads accounts. Spec 19.2 `@horagon/sdk/program`.
 */
export class HoragonProgram {
  readonly programId: PublicKey
  readonly pmAmmProgramId: PublicKey
  readonly collateralMint: PublicKey

  constructor(opts: HoragonProgramOptions) {
    this.programId = opts.programId ?? HORAGON_PROGRAM_ID
    this.pmAmmProgramId = opts.pmAmmProgramId ?? PM_AMM_PROGRAM_ID
    this.collateralMint = opts.collateralMint
  }

  get config(): PublicKey {
    return deriveConfig(this.programId)
  }

  get authority(): PublicKey {
    return deriveAuthority(this.programId)
  }

  get treasury(): PublicKey {
    return deriveTreasury(this.collateralMint, this.programId)
  }

  addresses(marketId: bigint): MarketAddresses {
    return marketAddresses(marketId, this.programId, this.pmAmmProgramId)
  }

  private get ids() {
    return {
      programId: this.programId,
      pmAmmProgramId: this.pmAmmProgramId,
      collateralMint: this.collateralMint,
    }
  }

  readonly ix = {
    initializeConfig: (p: Bound<InitializeConfigParams>): TransactionInstruction =>
      buildInitializeConfigIx({ ...p, ...this.ids }),
    updateConfig: (p: Bound<UpdateConfigParams>): TransactionInstruction =>
      buildUpdateConfigIx({ ...p, ...this.ids }),
    createGameMarket: (p: Bound<CreateGameMarketParams>): TransactionInstruction =>
      buildCreateGameMarketIx({ ...p, ...this.ids }),
    /** [create Authority YES ATA, create Authority NO ATA, halt]. */
    halt: (p: Bound<HaltParams>, payer: PublicKey): TransactionInstruction[] => [
      ...authorityOutcomeAtaIxs(payer, { ...p, ...this.ids }),
      buildHaltIx({ ...p, ...this.ids }),
    ],
    proposeResult: (p: Bound<ProposeResultParams>): TransactionInstruction =>
      buildProposeResultIx({ ...p, ...this.ids }),
    challenge: (p: Bound<ChallengeParams>): TransactionInstruction =>
      buildChallengeIx({ ...p, ...this.ids }),
    finalize: (p: Bound<MarketIxParams>): TransactionInstruction =>
      buildFinalizeIx({ ...p, ...this.ids }),
    /** [create Authority YES ATA, create Authority NO ATA, recycle]. */
    recycle: (p: Bound<RecycleParams>, payer: PublicKey): TransactionInstruction[] => [
      ...authorityOutcomeAtaIxs(payer, { ...p, ...this.ids }),
      buildRecycleIx({ ...p, ...this.ids }),
    ],
    withdrawTreasury: (p: Bound<WithdrawTreasuryParams>): TransactionInstruction =>
      buildWithdrawTreasuryIx({ ...p, ...this.ids }),
  }

  async fetchConfig(connection: Connection): Promise<ConfigAccount | null> {
    const info = await connection.getAccountInfo(this.config, 'confirmed')
    return info ? decodeConfig(info, this.programId) : null
  }

  async fetchGameMarket(
    connection: Connection,
    marketId: bigint,
  ): Promise<GameMarketAccount | null> {
    const info = await connection.getAccountInfo(
      deriveGameMarket(marketId, this.programId),
      'confirmed',
    )
    return info ? decodeGameMarket(info, this.programId) : null
  }

  /** Every GameMarket of this deployment (one getProgramAccounts with a discriminator filter). */
  async listGameMarkets(
    connection: Connection,
  ): Promise<Array<{ pubkey: PublicKey; account: GameMarketAccount }>> {
    const rows = await connection.getProgramAccounts(this.programId, {
      commitment: 'confirmed',
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: Buffer.from(HORAGON_ACCOUNT_DISCRIMINATORS.GameMarket).toString('base64'),
            encoding: 'base64',
          },
        },
      ],
    })
    return rows.map(({ pubkey, account }) => {
      try {
        return { pubkey, account: decodeGameMarket(account, this.programId) }
      } catch (cause) {
        throw new HoragonError('PROGRAM_ERROR', `cannot decode GameMarket ${pubkey.toBase58()}`, {
          cause,
        })
      }
    })
  }
}
