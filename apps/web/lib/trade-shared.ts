// What the screens share with the send code of lib/trade.ts, without web3.js (R5c): the stages of
// a send, the slippage it allows, and the transaction an error names. lib/trade.ts signs, so it
// loads with the first send; the crown and ErrorText read these on every page load.
import { errorSignature } from '@horagon/sdk'

export type TradeStage = 'building' | 'signing' | 'submitting' | 'confirming' | 'requoting'

export const DEFAULT_SLIPPAGE_BPS = 200

/** The transaction an error names (it may still land), or null. Read through the SDK only. */
export const failedSignature = (err: unknown): string | null => errorSignature(err) ?? null
