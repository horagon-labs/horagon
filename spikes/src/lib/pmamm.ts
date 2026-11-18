import { AnchorProvider } from '@anchor-lang/core'
import { PmAmmClient } from '@horagon/pm-amm-vendor'
import { DEVNET_MUSDC_MINT, PM_AMM_PROGRAM_ID } from '@horagon/sdk/pm-amm'
import {
  type Connection,
  type Keypair,
  type PublicKey,
  type Transaction,
  VersionedTransaction,
} from '@solana/web3.js'

/** Minimal Anchor wallet over a local keypair (avoids Anchor's Node-only `Wallet` export). */
export class KeypairWallet {
  constructor(readonly payer: Keypair) {}

  get publicKey(): PublicKey {
    return this.payer.publicKey
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (tx instanceof VersionedTransaction) tx.sign([this.payer])
    else tx.partialSign(this.payer)
    return tx
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    for (const tx of txs) await this.signTransaction(tx)
    return txs
  }
}

/** A signing client of the vendored pm-AMM SDK for `keypair`. */
export function pmAmmClient(
  connection: Connection,
  keypair: Keypair,
  collateralMint: PublicKey = DEVNET_MUSDC_MINT,
): PmAmmClient {
  const provider = new AnchorProvider(connection, new KeypairWallet(keypair), {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  })
  return PmAmmClient.fromProvider(provider, PM_AMM_PROGRAM_ID, collateralMint)
}
