// pmAmmFaucet maps every upstream answer to an ApiError or a result; a fake fetch, no network.
import { describe, expect, it } from 'vitest'
import { pmAmmFaucet } from '../src/faucet'
import { ApiError } from '../src/problem'

const URL = 'https://faucet.test/api/faucet'
const WALLET = '11111111111111111111111111111112'
const SIG = '5'.repeat(88)

type Call = { url: string; init: RequestInit }

function faucetWith(reply: () => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return reply()
  }) as unknown as typeof fetch
  return { claim: pmAmmFaucet(URL, fetchImpl), calls }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError)
    return e as ApiError
  }
  throw new Error('the faucet call did not fail')
}

describe('pmAmmFaucet', () => {
  it('posts the wallet as JSON and returns the signature and amount', async () => {
    const { claim, calls } = faucetWith(() => json(200, { ok: true, signature: SIG, amount: 1000 }))
    expect(await claim(WALLET)).toEqual({ signature: SIG, amount: 1000 })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.url).toBe(URL)
    expect(call?.init.method).toBe('POST')
    expect(call?.init.body).toBe(JSON.stringify({ wallet: WALLET }))
    expect(call?.init.headers).toMatchObject({
      'content-type': 'application/json',
      'user-agent': 'horagon-api/0.1',
    })
  })

  it('maps a transport failure to NETWORK 502, keeping the cause off the client', async () => {
    const cause = new Error('connect ECONNREFUSED')
    const { claim } = faucetWith(() => {
      throw cause
    })
    const err = await failure(claim(WALLET))
    expect(err.code).toBe('NETWORK')
    expect(err.extra.status).toBe(502)
    expect(err.extra.cause).toBe(cause)
    expect(err.message).not.toContain('ECONNREFUSED')
  })

  it('maps a 429 to RATE_LIMITED with the upstream retry-after, or an hour', async () => {
    const told = await failure(
      faucetWith(() => json(429, { error: 'wait' }, { 'retry-after': '1200' })).claim(WALLET),
    )
    expect(told.code).toBe('RATE_LIMITED')
    expect(told.extra.retryAfterSecs).toBe(1200)
    const untold = await failure(faucetWith(() => json(429, { error: 'wait' })).claim(WALLET))
    expect(untold.extra.retryAfterSecs).toBe(3600)
    const nonsense = await failure(
      faucetWith(() => json(429, {}, { 'retry-after': 'soon' })).claim(WALLET),
    )
    expect(nonsense.extra.retryAfterSecs).toBe(3600)
  })

  it('maps any other non-2xx to NETWORK 502', async () => {
    for (const status of [400, 500, 503]) {
      const err = await failure(faucetWith(() => json(status, { error: 'x' })).claim(WALLET))
      expect(err.code).toBe('NETWORK')
      expect(err.extra.status).toBe(502)
    }
  })

  it.each([
    ['ok false', { ok: false, signature: SIG, amount: 1000 }],
    ['a bad signature', { ok: true, signature: 'not-base58!', amount: 1000 }],
    ['amount 0', { ok: true, signature: SIG, amount: 0 }],
    ['a fractional amount', { ok: true, signature: SIG, amount: 1.5 }],
    ['no amount', { ok: true, signature: SIG }],
  ])('maps a 200 with %s to NETWORK 502', async (_, body) => {
    const err = await failure(faucetWith(() => json(200, body)).claim(WALLET))
    expect(err.code).toBe('NETWORK')
    expect(err.extra.status).toBe(502)
  })

  it('maps a 200 that is not JSON to NETWORK 502', async () => {
    const err = await failure(
      faucetWith(() => new Response('<html>', { status: 200 })).claim(WALLET),
    )
    expect(err.code).toBe('NETWORK')
  })
})
