// Wallet texts that depend on state, kept pure so they are tested.
import { parseAmount } from '@horagon/sdk'

const EXPORT_FIRST = 'Export it first (Show secret key) if it holds anything you want to keep.'

/**
 * The question before an import replaces the burner. lib/burner.ts keeps the replaced key in
 * the store; with blocked storage (`ephemeral`) that store is this tab's memory only.
 */
export function replacePrompt(ephemeral: boolean): string {
  return ephemeral
    ? `Replace this wallet? Storage is blocked in this browser, so its key is kept only until you close this tab. ${EXPORT_FIRST}`
    : `Replace this wallet? Its key stays saved on this device, but Horagon will not show it again. ${EXPORT_FIRST}`
}

export const WALLET_READY = 'Your play wallet is ready. Get play mUSDC from the faucet to start.'

/**
 * The faucet hint for a burner this tab's gate just created, while it holds no mUSDC (or its
 * balance is not known yet); null otherwise.
 */
export function readyHint(createdHere: boolean, balance: string | null | undefined): string | null {
  if (!createdHere) return null
  if (balance === null || balance === undefined) return WALLET_READY
  return parseAmount(balance) === 0n ? WALLET_READY : null
}
