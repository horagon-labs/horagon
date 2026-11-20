// POST /faucet (spec 9): forwards to the pm-AMM devnet faucet, one claim per wallet per hour
// there, plus Horagon's own per-wallet and per-IP buckets so a bot cannot drain it via us.
import { rateLimitRefund, rateLimitTake } from '@horagon/db'
import { errorSummary, formatAmount, parseAmount, SignatureSchema } from '@horagon/sdk'
import { z } from 'zod'
import type { ApiDeps, FaucetClient, FaucetResult } from './deps'
import { ApiError } from './problem'
import { hashIp } from './sponsor/submit'

export const PM_AMM_FAUCET_URL = 'https://pm-amm-devnet.vercel.app/api/faucet'

/** What the pm-AMM faucet answers on success (S5): `amount` is whole mUSDC, e.g. 1000. */
const FaucetAnswerSchema = z.object({
  ok: z.literal(true),
  signature: SignatureSchema,
  amount: z.number().int().positive(),
})

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
    } catch (cause) {
      throw new ApiError('NETWORK', 'The pm-AMM faucet did not answer', { status: 502, cause })
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get('retry-after'))
      throw new ApiError('RATE_LIMITED', 'This wallet already claimed in the last hour', {
        retryAfterSecs: Number.isFinite(retry) && retry > 0 ? retry : 3600,
        hint: 'The faucet gives 1,000 mUSDC per wallet per hour. Try again later.',
      })
    }
    if (!res.ok) {
      throw new ApiError('NETWORK', `The pm-AMM faucet answered ${res.status}`, { status: 502 })
    }
    const answer = FaucetAnswerSchema.safeParse(await res.json().catch(() => null))
    if (!answer.success) {
      throw new ApiError('NETWORK', 'The pm-AMM faucet sent an answer Horagon does not know', {
        status: 502,
      })
    }
    return { signature: answer.data.signature, amount: answer.data.amount }
  }
}

/** Give back tokens taken for a claim that did not happen; a failure here is only logged. */
async function refund(deps: ApiDeps, taken: ReadonlyArray<[string, number]>): Promise<void> {
  for (const [key, capacity] of taken) {
    try {
      await rateLimitRefund(deps.db, key, { capacity })
    } catch (e) {
      deps.log.warn({ error: errorSummary(e), key }, 'faucet refund failed')
    }
  }
}

export async function claimFaucet(deps: ApiDeps, wallet: string, ip: string) {
  const ipHash = await hashIp(ip, deps.ipSalt)
  const buckets: Array<[string, number]> = [
    [`faucet:w:${wallet}`, 1],
    [`faucet:ip:${ipHash}`, 5],
  ]
  const taken: Array<[string, number]> = []
  for (const [key, perHour] of buckets) {
    const wait = await rateLimitTake(deps.db, key, {
      capacity: perHour,
      refillPerSec: perHour / 3600,
    })
    if (wait > 0) {
      // The IP is out: this wallet did not claim, so its own token goes back.
      await refund(deps, taken)
      throw new ApiError('RATE_LIMITED', 'Faucet limit reached', {
        retryAfterSecs: wait,
        hint: 'The faucet gives 1,000 mUSDC per wallet per hour. Try again later.',
      })
    }
    taken.push([key, perHour])
  }
  let r: FaucetResult
  try {
    r = await deps.faucet(wallet)
  } catch (e) {
    // The upstream's own 429 means the wallet did claim within the hour: those tokens stay
    // spent. Any other failure (network, timeout, 5xx, an unknown answer) gave nothing.
    if (!(e instanceof ApiError && e.code === 'RATE_LIMITED')) await refund(deps, taken)
    throw e
  }
  deps.log.info({ wallet, sig: r.signature }, 'faucet claimed')
  return { signature: r.signature, amountUsdc: formatAmount(parseAmount(String(r.amount))) }
}
