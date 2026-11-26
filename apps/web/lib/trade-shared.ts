// What the screens share with the send code of lib/trade.ts, without web3.js (R5c): the stages of
// a send, the slippage it allows, and the transaction an error names. lib/trade.ts signs, so it
// loads with the first send; the crown and ErrorText read these on every page load.
import { errorSignature } from '@horagon/sdk/client'

export type TradeStage = 'building' | 'signing' | 'submitting' | 'confirming' | 'requoting'

export const DEFAULT_SLIPPAGE_BPS = 200

/** The transaction an error names (it may still land), or null. Read through the SDK only. */
export const failedSignature = (err: unknown): string | null => errorSignature(err) ?? null

/**
 * Loads the signer, then sends only if the trade is still allowed as of now (R5c refix). The first
 * send of a page waits for that load, and the game can reach its final buzzer meanwhile, before
 * the keeper's halt reaches the index, when the API would still build. Null when `stillOk` refused:
 * nothing was built, signed or sent.
 */
export async function whenStillOk<M, R>(
  load: () => Promise<M>,
  stillOk: () => boolean,
  send: (signer: M) => Promise<R>,
): Promise<R | null> {
  const signer = await load()
  return stillOk() ? send(signer) : null
}
