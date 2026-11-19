import type { PublicKey } from '@solana/web3.js'

/** pm-AMM devnet faucet: 1,000 mUSDC (+ a little SOL during events) per wallet per hour. */
export const PM_AMM_FAUCET_URL = 'https://pm-amm-devnet.vercel.app/api/faucet'

export interface FaucetResponse {
  status: number
  /** Seconds from the `Retry-After` header, when it is a number. */
  retryAfterSecs?: number
  body: unknown
}

export async function requestFaucet(
  wallet: PublicKey,
  url = process.env.HORAGON_FAUCET_URL ?? PM_AMM_FAUCET_URL,
): Promise<FaucetResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wallet: wallet.toBase58() }),
  })
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // Not JSON: keep the raw text for the record.
  }
  const retryAfter = Number(res.headers.get('retry-after') ?? Number.NaN)
  return Number.isFinite(retryAfter)
    ? { status: res.status, retryAfterSecs: retryAfter, body }
    : { status: res.status, body }
}
