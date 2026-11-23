import { getDraft } from '@horagon/db'
import { transactionPooler } from '@horagon/db/test-support'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { depsFromEnv } from '../src/config'
import { RPC_TIMEOUT_MS, timeoutFetch } from '../src/rpc-fetch'

const env = { HORAGON_RPC_URL: 'http://127.0.0.1:8899', IP_HASH_SALT: 'salt' }

describe('the API database client', () => {
  const cleanup: Array<() => unknown> = []
  afterEach(async () => {
    for (const f of cleanup.splice(0).reverse()) await f()
  })

  it('built from DATABASE_URL, survives a burst through a pooler that loses pipelined queries', async () => {
    const pooler = await transactionPooler()
    // No db passed: depsFromEnv opens its own, as in production. The URL is the local stand-in.
    const { db } = depsFromEnv({ ...env, DATABASE_URL: pooler.url })
    cleanup.push(pooler.close)
    const burst = Promise.all(Array.from({ length: 12 }, (_, i) => getDraft(db, `nba-${i}e2e`)))
    const result = await Promise.race([
      burst,
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 3_000)),
    ])
    expect(result).toEqual(Array(12).fill(null))
    expect(pooler.pipelined).toBe(0)
  })
})

describe('the API RPC connection', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('times out a hung endpoint', async () => {
    const hang: typeof fetch = (_i, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    await expect(timeoutFetch(20, hang)('https://x.example')).rejects.toMatchObject({
      name: 'TimeoutError',
    })
    // The caller's own signal still aborts too.
    const caller = new AbortController()
    const pending = timeoutFetch(60_000, hang)('https://x.example', { signal: caller.signal })
    caller.abort(new Error('caller gave up'))
    await expect(pending).rejects.toThrow('caller gave up')
  })

  it('is built with that timeout: every call carries an abort signal', async () => {
    expect(RPC_TIMEOUT_MS).toBe(15_000)
    let signal: AbortSignal | null | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_i: unknown, init?: RequestInit) => {
        signal = init?.signal
        return new Promise(() => {})
      }),
    )
    const { connection } = depsFromEnv(env, {} as never)
    void connection.getSlot().catch(() => {})
    await vi.waitFor(() => expect(signal).toBeInstanceOf(AbortSignal))
    expect(signal?.aborted).toBe(false)
  })
})
