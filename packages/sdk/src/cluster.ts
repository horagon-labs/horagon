import type { Connection } from '@solana/web3.js'
import { HoragonError } from './errors'

/** Genesis hash of Solana mainnet-beta: an RPC reporting it serves mainnet, whatever its URL. */
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'

/**
 * Horagon runs on devnet and localnet only (spec 19.1). A URL check catches "mainnet" in the
 * address; this catches a mainnet RPC behind any address. An RPC failure is rethrown as it is,
 * so the caller decides how to fail closed.
 */
export async function assertNotMainnetGenesis(
  connection: Pick<Connection, 'getGenesisHash'>,
): Promise<void> {
  const genesis = await connection.getGenesisHash()
  if (genesis === MAINNET_GENESIS_HASH) {
    throw new HoragonError('MAINNET_DISABLED', 'The RPC serves Solana mainnet (its genesis hash)')
  }
}
