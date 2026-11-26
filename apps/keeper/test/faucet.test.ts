import { describe, expect, it } from 'vitest'
import { faucetClaim } from '../src/faucet'

describe('faucetClaim', () => {
  it('posts the wallet, and throws on any answer but 2xx', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const answer = (status: number) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push([String(url), init])
        return new Response('{}', { status })
      }) as typeof fetch
    await faucetClaim('https://faucet.example/api', 'WALLET', answer(200))
    expect(calls[0]?.[0]).toBe('https://faucet.example/api')
    expect(calls[0]?.[1]?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ wallet: 'WALLET' })
    await expect(faucetClaim('https://faucet.example/api', 'WALLET', answer(429))).rejects.toThrow(
      'faucet answered 429',
    )
  })
})
