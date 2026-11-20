// POST /faucet (spec 9): forwards to the pm-AMM devnet faucet, one claim per wallet per hour
// there, plus Horagon's own per-wallet and per-IP buckets so a bot cannot drain it via us.
import { rateLimitTake } from '@horagon/db'
import type { ApiDeps, FaucetClient } from './deps'
import { ApiError } from './problem'
import { hashIp } from './sponsor/submit'

export const PM_AMM_FAUCET_URL = 'https://pm-amm-devnet.vercel.app/api/faucet'

/** Real faucet client. `fetchImpl` is injectable for tests. */
export function pmAmmFaucet(
  url = PM_AMM_FAUCET_URL,
  fetchImpl: typeof fetch = fetch,
): FaucetClient {
  return async (wallet) => {
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'horagon-api/0.1' },
        body: JSON.stringify({ wallet }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      throw new ApiError('NETWORK', 'The pm-AMM faucet did not answer', { status: 502 })
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after'))
      throw new ApiError('RATE_LIMITED', 'This wallet already claimed in the last hour', {
        retryAfterSecs: Number.isFinite(retry) && retry > 0 ? retry : 3600,
        hint: 'The faucet gives 1,000 mUSDC per wallet per hour. Try again later.',
      })
    }
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean
      signature?: string
      amount?: number
    } | null
    if (!res.ok || !body?.ok) {
      throw new ApiError('NETWORK', `The pm-AMM faucet answered ${res.status}`, { status: 502 })
    }
    return { signature: body.signature ?? null, amount: body.amount ?? 1_000 }
  }
}

export async function claimFaucet(deps: ApiDeps, wallet: string, ip: string) {
  const ipHash = await hashIp(ip, deps.ipSalt)
  const buckets: Array<[string, number]> = [
    [`faucet:w:${wallet}`, 1],
    [`faucet:ip:${ipHash}`, 5],
  ]
  for (const [key, perHour] of buckets) {
    const wait = await rateLimitTake(deps.db, key, {
      capacity: perHour,
      refillPerSec: perHour / 3600,
    })
    if (wait > 0) {
      throw new ApiError('RATE_LIMITED', 'Faucet limit reached', {
        retryAfterSecs: wait,
        hint: 'The faucet gives 1,000 mUSDC per wallet per hour. Try again later.',
      })
    }
  }
  const r = await deps.faucet(wallet)
  deps.log.info({ wallet, sig: r.signature }, 'faucet claimed')
  return { signature: r.signature, amountUsdc: String(r.amount) }
}
