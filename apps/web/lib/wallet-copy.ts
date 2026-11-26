// Wallet texts that depend on state, kept pure so they are tested.
import { parseAmount } from '@horagon/sdk/amount'

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
 * The faucet's button (audit 13: one CTA, no crypto jargon). The pm-AMM devnet faucet grants
 * 1,000 mUSDC a claim (S5, lib/faucet.ts reports what it really added).
 */
export const FAUCET_BUTTON = 'Get 1,000 play mUSDC'

/** Any failure with no words of its own: never a stack, a chunk name or an RPC URL. */
export const SOMETHING_WRONG = 'Something went wrong. Try again.'

/**
 * A wallet button while its action waits for the wallet's key code to load (R5c refix): the
 * first set-up, faucet request or Import of a page fetches it, which takes a moment on a slow link.
 */
export const WALLET_PREPARING = 'Preparing…'

/**
 * What a failed Import says. The key's own problem (not base58, wrong length, mismatched halves)
 * is a plain Error with words for the player; anything else (a ChunkLoadError, a TypeError, a
 * refused save) says nothing about the key, so a working key is never called bad.
 */
export const importErrorText = (err: unknown): string =>
  err instanceof Error && err.name === 'Error' ? err.message : SOMETHING_WRONG

/** The crown's wallet line before the browser storage has opened (server render, first render). */
export const WALLET_LOADING = 'Loading your balance…'

/** The crown's first button for a device with no wallet yet (R5): it creates one and funds it. */
export const SET_UP_BUTTON = 'Get 1,000 play mUSDC to start'

/**
 * The faucet hint for a burner this tab's gate just created, while it holds no mUSDC (or its
 * balance is not known yet); null otherwise.
 */
export function readyHint(createdHere: boolean, balance: string | null | undefined): string | null {
  if (!createdHere) return null
  if (balance === null || balance === undefined) return WALLET_READY
  return parseAmount(balance) === 0n ? WALLET_READY : null
}
