// Index reads over an ordered list of RPC endpoints, each with its own pace: a read goes to the
// first endpoint not paused, and a rate limit, an auth refusal, a 5xx, a timeout or an unusable
// answer pauses that endpoint and sends the same read to the next one. Fakes on a fake clock.
import { Keypair } from '@solana/web3.js'
import type { Logger } from 'pino'
import { describe, expect, it } from 'vitest'
import { makeConnection } from '../src/config'
import { IndexPace, RATE_LIMIT_PAGE_AFTER_MS } from '../src/index-pace'
import { EveryEndpointDown, IndexReads, NOT_NOW, readFailure } from '../src/index-reads'

const RATE_LIMIT = () =>
  new Error(
    '429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests for a specific RPC call"}}',
  )

describe('readFailure', () => {
  it('names the failures that move index reads to the next endpoint', () => {
    expect(readFailure(RATE_LIMIT())).toBe('rate-limit')
    expect(readFailure(Object.assign(new Error('node is behind'), { code: -32005 }))).toBe(
      'rate-limit',
    )
    expect(readFailure(new Error('401 Unauthorized: {"error":"invalid api key"}'))).toBe('auth')
    expect(readFailure(new Error('403 Forbidden: '))).toBe('auth')
    expect(
      readFailure(
        Object.assign(
          new Error(
            'failed to get signatures for address: method not available for anonymous access',
          ),
          { code: -16401 },
        ),
      ),
    ).toBe('auth')
    expect(readFailure(new Error('Unauthorized'))).toBe('auth')
    expect(readFailure(new Error('502 Bad Gateway: upstream'))).toBe('server')
    expect(readFailure(new Error('503 Service Unavailable: '))).toBe('server')
    expect(readFailure({ status: 500 })).toBe('server')
    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    expect(readFailure(timeout)).toBe('timeout')
    expect(
      readFailure(new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })),
    ).toBe('timeout')
    expect(readFailure(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))).toBe(
      'unreachable',
    )
    expect(readFailure(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }))).toBe(
      'unreachable',
    )
    // A provider that refuses a request it does not serve (a batch, a method).
    expect(readFailure(new Error('400 Bad Request: batch requests are not allowed'))).toBe(
      'refused',
    )
    expect(readFailure(Object.assign(new Error('Method not found'), { code: -32601 }))).toBe(
      'refused',
    )
    // A batch answered with one error object instead of a list (web3.js maps over it).
    expect(readFailure(new TypeError('unsafeRes.map is not a function'))).toBe('bad-answer')
  })

  it('leaves the failures that are not the endpoint as they are', () => {
    expect(readFailure(new Error('fetch failed'))).toBeNull()
    expect(readFailure(Object.assign(new Error('blockhash'), { code: -32002 }))).toBeNull()
    expect(readFailure(new Error('slot 14290 skipped'))).toBeNull()
    expect(readFailure(new Error('duplicate key value violates unique constraint'))).toBeNull()
    expect(readFailure(null)).toBeNull()
  })
})

describe('readFailure on the errors web3.js throws', () => {
  const key = Keypair.generate().publicKey
  /** A Connection whose RPC answers `answer(body)`; the keeper's own options. */
  const conn = (
    answer: (body: unknown, signal?: AbortSignal | null) => Response | Promise<Response>,
    timeoutMs?: number,
  ) =>
    makeConnection('https://rpc.devnet.example', undefined, {
      fetchImpl: (async (_url: string, init?: RequestInit) =>
        answer(JSON.parse(String(init?.body)), init?.signal)) as unknown as typeof fetch,
      ...(timeoutMs ? { timeoutMs } : {}),
    })
  const http = (status: number, statusText: string) => () =>
    new Response('{"error":"no"}', { status, statusText })
  const rpcError = (code: number, message: string) => (body: unknown) =>
    new Response(
      JSON.stringify({ jsonrpc: '2.0', id: (body as { id: string }).id, error: { code, message } }),
    )
  const failureOf = async (p: Promise<unknown>) => {
    try {
      await p
      return 'answered'
    } catch (err) {
      return readFailure(err)
    }
  }
  const sigs = (c: ReturnType<typeof conn>) => c.getSignaturesForAddress(key)

  it('classes HTTP statuses, JSON-RPC codes, timeouts and a batch answered with one object', async () => {
    expect(await failureOf(sigs(conn(http(429, 'Too Many Requests'))))).toBe('rate-limit')
    expect(await failureOf(sigs(conn(http(401, 'Unauthorized'))))).toBe('auth')
    expect(await failureOf(sigs(conn(http(403, 'Forbidden'))))).toBe('auth')
    expect(await failureOf(sigs(conn(http(503, 'Service Unavailable'))))).toBe('server')
    expect(await failureOf(sigs(conn(http(400, 'Bad Request'))))).toBe('refused')
    expect(
      await failureOf(sigs(conn(rpcError(-16401, 'not available for anonymous access')))),
    ).toBe('auth')
    expect(await failureOf(sigs(conn(rpcError(-32005, 'Node is behind'))))).toBe('rate-limit')
    expect(await failureOf(sigs(conn(rpcError(-32601, 'Method not found'))))).toBe('refused')
    expect(await failureOf(sigs(conn(rpcError(-32009, 'Slot 1 was skipped'))))).toBeNull()
    const hang = (_body: unknown, signal?: AbortSignal | null) =>
      new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason))
      })
    expect(await failureOf(sigs(conn(hang, 20)))).toBe('timeout')
    const single = () =>
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'no batch' } }),
      )
    expect(
      await failureOf(conn(single).getTransactions(['1'], { maxSupportedTransactionVersion: 0 })),
    ).toBe('bad-answer')
  })
})

/** Endpoints on one fake clock, each with its own pace; `fail` makes one throw. */
function fakeReads(names = ['a', 'b', 'c'], onRead?: () => void) {
  let t = 1_000_000
  const infos: Array<{ obj: Record<string, unknown>; msg: string }> = []
  const warns: Array<{ obj: Record<string, unknown>; msg: string }> = []
  const sent: Array<{ key: string; text: string }> = []
  const calls: string[] = []
  const fail = new Map<string, () => Error>()
  const log = {
    warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }),
    info: (obj: Record<string, unknown>, msg: string) => infos.push({ obj, msg }),
    debug: () => {},
  } as unknown as Logger
  const alerts = {
    send: async (key: string, text: string) => {
      sent.push({ key, text })
    },
  }
  const clock = () => t
  const sleep = async (ms: number) => {
    t += ms
  }
  const endpoints = names.map((name) => ({
    name: `HORAGON_${name.toUpperCase()}`,
    host: `${name}.rpc.example`,
    connection: () => ({
      read: async (what: string) => {
        calls.push(`${name}:${what}`)
        const f = fail.get(name)
        if (f) throw f()
        return `${name}:${what}`
      },
    }),
    pace: new IndexPace({ log, clock, random: () => 0, sleep }),
  }))
  const reads = new IndexReads({ endpoints, log, alerts, clock, ...(onRead ? { onRead } : {}) })
  return {
    reads,
    endpoints,
    infos,
    warns,
    sent,
    calls,
    fail,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('IndexReads', () => {
  it('reads from the first endpoint while it answers', async () => {
    const f = fakeReads()
    const pass = await f.reads.begin('index')
    if (!pass) throw new Error('paused')
    expect(await pass.accounts((c) => c.read('accounts'))).toBe('a:accounts')
    expect(await pass.signatures((c) => c.read('sigs'))).toBe('a:sigs')
    pass.end()
    expect(f.calls).toEqual(['a:accounts', 'a:sigs'])
    expect(f.sent).toEqual([])
  })

  it('moves a failed read to the next endpoint in the same pass, and pages index-failover', async () => {
    const f = fakeReads()
    const pass = await f.reads.begin('index')
    if (!pass) throw new Error('paused')
    expect(await pass.accounts((c) => c.read('accounts'))).toBe('a:accounts')
    f.fail.set('a', RATE_LIMIT)
    // The same read, answered by b: nothing read before is lost.
    expect(await pass.signatures((c) => c.read('sigs'))).toBe('b:sigs')
    expect(await pass.signatures((c) => c.read('sigs2'))).toBe('b:sigs2')
    pass.end()
    expect(f.calls).toEqual(['a:accounts', 'a:sigs', 'b:sigs', 'b:sigs2'])
    expect(f.warns.filter((w) => w.msg.includes('pausing'))).toHaveLength(1)
    expect(f.warns[0]?.obj).toMatchObject({
      source: 'index',
      indexRpc: 'HORAGON_A',
      indexRpcHost: 'a.rpc.example',
      failure: 'rate-limit',
      delayMs: 30_000,
    })
    expect(f.infos.at(-1)?.obj).toMatchObject({ from: 'HORAGON_A', to: 'HORAGON_B' })
    expect(f.sent.map((s) => s.key)).toEqual(['index-failover'])
    expect(f.sent[0]?.text).toContain('b.rpc.example')
    expect(f.sent[0]?.text).toContain('rate-limit')
  })

  it('goes back to the first endpoint once its back-off ends, with an info log and no page', async () => {
    const f = fakeReads()
    f.fail.set('a', () => new Error('503 Service Unavailable: '))
    let pass = await f.reads.begin('index')
    await pass?.accounts((c) => c.read('x'))
    pass?.end()
    expect(f.calls).toEqual(['a:x', 'b:x'])
    f.fail.delete('a')
    f.advance(10_000)
    pass = await f.reads.begin('index')
    await pass?.accounts((c) => c.read('y'))
    pass?.end()
    expect(f.calls.at(-1)).toBe('b:y')
    f.advance(20_000)
    pass = await f.reads.begin('index')
    await pass?.accounts((c) => c.read('z'))
    pass?.end()
    expect(f.calls.at(-1)).toBe('a:z')
    expect(f.infos.at(-1)?.obj).toMatchObject({ from: 'HORAGON_B', to: 'HORAGON_A' })
    expect(f.sent.map((s) => s.key)).toEqual(['index-failover'])
  })

  it('rethrows a failure that is not the endpoint, without pausing it', async () => {
    const f = fakeReads()
    f.fail.set('a', () => new Error('fetch failed'))
    const pass = await f.reads.begin('index')
    await expect(pass?.signatures((c) => c.read('sigs'))).rejects.toThrow('fetch failed')
    expect(f.calls).toEqual(['a:sigs'])
    expect(f.warns).toEqual([])
    expect(f.endpoints[0]?.pace.held()).toBe(false)
  })

  it('stops the pass when every endpoint is down, and holds the next passes', async () => {
    const f = fakeReads()
    for (const n of ['a', 'b', 'c']) f.fail.set(n, RATE_LIMIT)
    const pass = await f.reads.begin('index')
    await expect(pass?.accounts((c) => c.read('x'))).rejects.toBeInstanceOf(EveryEndpointDown)
    pass?.end()
    expect(f.calls).toEqual(['a:x', 'b:x', 'c:x'])
    expect(await f.reads.begin('ata-watch')).toBeNull()
    f.advance(30_000)
    expect(await f.reads.begin('index')).not.toBeNull()
  })

  it('pages index-rate-limited only once every endpoint has been down for more than 15 min', async () => {
    const f = fakeReads(['a', 'b'])
    f.fail.set('a', RATE_LIMIT)
    // a down for 20 min, b answering: never index-rate-limited.
    for (let s = 0; s <= 1_200; s += 5) {
      const pass = await f.reads.begin('index')
      await pass?.signatures((c) => c.read('s'))
      pass?.end()
      f.advance(5_000)
    }
    // Each probe of a moves the reads back and forth; the alerter's 3 h window drops repeats.
    expect(new Set(f.sent.map((s) => s.key))).toEqual(new Set(['index-failover']))
    // Then b goes down too: the page comes after more than 15 min of both down.
    f.fail.set('b', () => new Error('401 Unauthorized: '))
    let paged = -1
    for (let s = 0; s <= 1_500; s += 5) {
      const pass = await f.reads.begin('index')
      await pass?.signatures((c) => c.read('s')).catch(() => {})
      pass?.end()
      if (paged < 0 && f.sent.some((x) => x.key === 'index-rate-limited')) paged = s
      f.advance(5_000)
    }
    expect(paged * 1000).toBeGreaterThan(RATE_LIMIT_PAGE_AFTER_MS)
    expect(paged * 1000).toBeLessThanOrEqual(RATE_LIMIT_PAGE_AFTER_MS + 600_000)
    const page = f.sent.find((x) => x.key === 'index-rate-limited')
    expect(page?.text).toMatch(/for 1[5-9] min/)
    expect(page?.text).toContain('HORAGON_INDEX_RPC_URL')
  })

  it('does not page a streak of 15 min or less, and a clean pass ends the streak', async () => {
    const f = fakeReads(['a'])
    f.fail.set('a', RATE_LIMIT)
    let pass = await f.reads.begin('index')
    await pass?.accounts((c) => c.read('x')).catch(() => {})
    pass?.end()
    f.advance(RATE_LIMIT_PAGE_AFTER_MS)
    pass = await f.reads.begin('index')
    await pass?.accounts((c) => c.read('x')).catch(() => {})
    pass?.end()
    expect(f.sent).toEqual([])
    f.advance(1)
    expect(await f.reads.begin('index')).toBeNull()
    expect(f.sent.map((s) => s.key)).toEqual(['index-rate-limited'])
    // A clean pass: the next failure starts the back-off and the streak over.
    f.fail.delete('a')
    f.advance(600_000)
    pass = await f.reads.begin('index')
    await pass?.accounts((c) => c.read('x'))
    pass?.end()
    f.fail.set('a', RATE_LIMIT)
    pass = await f.reads.begin('index')
    await pass?.accounts((c) => c.read('x')).catch(() => {})
    pass?.end()
    expect(f.warns.at(-1)?.obj).toMatchObject({ delayMs: 30_000 })
    expect(f.sent).toHaveLength(1)
  })

  it('does not start the back-off over for an endpoint that failed in the pass', async () => {
    const f = fakeReads(['a'])
    const delays = () =>
      f.warns.filter((w) => w.msg.includes('pausing')).map((w) => w.obj.delayMs as number)
    for (let i = 0; i < 3; i++) {
      const pass = await f.reads.begin('index')
      await pass?.accounts((c) => c.read('accounts'))
      f.fail.set('a', RATE_LIMIT)
      await pass?.signatures((c) => c.read('sigs')).catch(() => {})
      f.fail.delete('a')
      pass?.end()
      f.advance(600_000)
    }
    expect(delays()).toEqual([30_000, 60_000, 120_000])
  })

  it('takes transaction entries from the active endpoint budget, NOT_NOW when it would wait too long', async () => {
    const f = fakeReads()
    const pass = await f.reads.begin('index')
    if (!pass) throw new Error('paused')
    expect(await pass.transactions(10, 0, (c) => c.read('tx1'))).toBe('a:tx1')
    expect(await pass.transactions(10, 1_000, (c) => c.read('tx2'))).toBe(NOT_NOW)
    expect(f.calls).toEqual(['a:tx1'])
    // A failover takes from the next endpoint's own budget, at once.
    f.fail.set('a', RATE_LIMIT)
    f.advance(3_500)
    expect(await pass.transactions(10, 0, (c) => c.read('tx3'))).toBe('b:tx3')
  })

  it('reports every read that answered or failed, for the index loop liveness', async () => {
    let n = 0
    const f = fakeReads(['a', 'b'], () => n++)
    const pass = await f.reads.begin('index')
    if (!pass) throw new Error('paused')
    await pass.accounts((c) => c.read('accounts'))
    expect(n).toBe(1)
    // A failure on a, then the answer on b.
    f.fail.set('a', RATE_LIMIT)
    await pass.signatures((c) => c.read('sigs'))
    expect(n).toBe(3)
    // Nothing read: not progress.
    expect(await pass.transactions(10, 0, (c) => c.read('tx1'))).toBe('b:tx1')
    expect(await pass.transactions(10, 0, (c) => c.read('tx2'))).toBe(NOT_NOW)
    expect(n).toBe(4)
  })
})
