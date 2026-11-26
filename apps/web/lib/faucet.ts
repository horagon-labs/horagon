// The faucet request, shared by the wallet sheet and the trade panel.
import type { HoragonClient } from '@horagon/sdk'
import { usdc } from './format'

export type FaucetClient = Pick<HoragonClient, 'faucet'>

/** Asks the faucet to fund `wallet`; returns the line to show. Errors are the caller's to show. */
export async function requestFunds(client: FaucetClient, wallet: string): Promise<string> {
  const r = await client.faucet(wallet)
  return `Added ${usdc(r.amountUsdc)} play mUSDC.`
}
