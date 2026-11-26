// The pm-AMM devnet faucet: 1,000 mUSDC into a wallet, rate limited per wallet. The keeper
// claims it hourly into its own wallet (treasury.ts), and the reference agent into its own.
import { USER_AGENT } from './feeds/espn'

/** Claims the faucet into `wallet`; throws on any answer but 2xx (a rate limit included). */
export async function faucetClaim(
  url: string,
  wallet: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ wallet }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`faucet answered ${res.status}`)
}
