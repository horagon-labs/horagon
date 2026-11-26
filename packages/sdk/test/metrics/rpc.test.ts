import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  createRpc,
  type FanReport,
  fetchGameMarkets,
  fetchSignatures,
  fetchSwaps,
  type GameMarketRecord,
  HORAGON_PROGRAM_ID,
  type RawTransaction,
  type RpcOptions,
} from '../../../../scripts/count-fans.mjs'
import {
  DISCRIMINATORS,
  fakeClock,
  fakeRpc,
  fakeSignature,
  gameMarketData,
  gameMarketKey,
  pmAmmMarketKey,
  type Season,
  type SeasonMarket,
  seasonChain,
  walletKey,
} from './fake-chain'

const RPC_URL = 'http://127.0.0.1:8899'
const fixture = (name: string) =>
  readFileSync(new URL(`../../../../tests/fixtures/metrics/${name}`, import.meta.url), 'utf8')

interface BigMarketFixture {
  pages: { market: string; signatures: number; failed: number; secondPageBefore: string }
  season: Season
  expected: FanReport
}
const bigMarket = JSON.parse(fixture('big-market.json')) as BigMarketFixture

const unix = (iso: string) => Date.parse(iso) / 1000
const nba = (label: string, game: string, tipoff: string): SeasonMarket => ({
  label,
  kind: 0,
  league: 'NBA',
  game,
  tipoff,
})
const M1 = nba('m1', '401810201', '2026-11-24T19:00:00-05:00')
const M2 = nba('m2', '401810202', '2026-11-24T21:30:00-05:00')
const T = unix('2026-11-25T00:30:00Z')
const at = (seconds: number) => new Date((T + seconds) * 1000).toISOString()

/** The GameMarketRecords of a season, built from its labels and not by the script's decoder. */
const records = (season: Season): GameMarketRecord[] =>
  season.markets.map((m) => ({
    address: gameMarketKey(m.label),
    market: pmAmmMarketKey(m.label),
    kind: m.kind,
    league: m.league,
    gameId: m.game,
    scheduledTipoff: unix(m.tipoff),
  }))

type RetryInfo = Parameters<NonNullable<RpcOptions['onRetry']>>[0]

/** An Rpc on a fake node over `season`, with a fake clock that starts at `start`. */
function setup(
  season: Season = { markets: [], swaps: [] },
  options: { start?: number; wrap?: (serve: typeof fetch) => typeof fetch } = {},
) {
  const chain = seasonChain(season)
  const clock = fakeClock(options.start)
  const node = fakeRpc(chain, clock)
  const retries: RetryInfo[] = []
  const rpc = createRpc(RPC_URL, {
    fetch: options.wrap?.(node.fetch) ?? node.fetch,
    now: clock.now,
    sleep: clock.sleep,
    onRetry: (info) => retries.push(info),
  })
  return { chain, clock, node, rpc, retries }
}

const reply = (status: number, headers: Record<string, string> = {}, body = '') =>
  new Response(body, { status, headers })
const networkError = () => new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })

/**
 * Sends every request on to the node, which records it, but answers the first ones with these
 * faults: a Response to return instead, or an Error to throw.
 */
const withFaults =
  (faults: (Response | Error)[]) =>
  (serve: typeof fetch): typeof fetch =>
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await serve(input, init)
    const fault = faults.shift()
    if (fault instanceof Error) throw fault
    return fault ?? answer
  }

type TxChange = (tx: Record<string, unknown>) => Record<string, unknown>

/** A copy of `record` without the key `key`. */
const without = (record: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))

/**
 * Answers of a node that has a transaction, but not in full yet. A full answer has a meta object
 * with an err key, null for a successful transaction, and a numeric blockTime.
 */
const incomplete: [string, TxChange][] = [
  ['meta is null', (tx) => ({ ...tx, meta: null })],
  ['meta is missing', (tx) => without(tx, 'meta')],
  ['meta is not an object', (tx) => ({ ...tx, meta: [] })],
  [
    'meta has no err',
    (tx) => ({ ...tx, meta: without(tx.meta as Record<string, unknown>, 'err') }),
  ],
  ['blockTime is null', (tx) => ({ ...tx, blockTime: null })],
  ['blockTime is missing', (tx) => without(tx, 'blockTime')],
]

/**
 * Sends every request on to the node, but answers the first `times` getTransaction calls with the
 * node's transaction changed by `change`.
 */
const changeTransactions =
  (change: TxChange, times = Number.POSITIVE_INFINITY) =>
  (serve: typeof fetch): typeof fetch =>
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const answer = await serve(input, init)
    if (JSON.parse(String(init?.body)).method !== 'getTransaction' || times-- <= 0) return answer
    const body = await answer.json()
    return new Response(JSON.stringify({ ...body, result: change(body.result) }))
  }

const listSignatures = (address = walletKey('fan')) => [address, { limit: 1000 }]

describe('createRpc', () => {
  it('posts JSON-RPC 2.0 requests and resolves to the result', async () => {
    const sent: { url: string; init?: RequestInit }[] = []
    const { rpc } = setup(undefined, {
      wrap: (serve) => async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({ url: String(input), init })
        return serve(input, init)
      },
    })
    await expect(rpc.call('getSignaturesForAddress', listSignatures())).resolves.toEqual([])
    const accounts = [HORAGON_PROGRAM_ID, { encoding: 'base64' }]
    await expect(rpc.call('getProgramAccounts', accounts)).resolves.toEqual([])
    expect(sent.map(({ url, init }) => [url, init?.method, init?.headers])).toEqual([
      [RPC_URL, 'POST', { 'content-type': 'application/json' }],
      [RPC_URL, 'POST', { 'content-type': 'application/json' }],
    ])
    expect(sent.map(({ init }) => JSON.parse(String(init?.body)))).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: listSignatures() },
      { jsonrpc: '2.0', id: 2, method: 'getProgramAccounts', params: accounts },
    ])
    expect(sent.every(({ init }) => init?.signal instanceof AbortSignal)).toBe(true)
  })

  it('starts at most 4 requests a second, so 9 calls take 2 s', async () => {
    const { rpc, node, clock } = setup()
    for (let i = 0; i < 9; i++) await rpc.call('getSignaturesForAddress', listSignatures())
    const starts = node.requests.map((r) => r.at)
    expect(starts).toEqual([0, 250, 500, 750, 1000, 1250, 1500, 1750, 2000])
    expect(clock.now()).toBeGreaterThanOrEqual(2000)
    // No second, wherever it starts, holds a fifth request.
    expect(starts.slice(4).every((t, i) => t - (starts[i] ?? 0) >= 1000)).toBe(true)
    expect(rpc.calls).toBe(9)
  })

  it('queues calls made at the same time, with the default clock and sleep', async () => {
    vi.useFakeTimers({ now: 0 })
    try {
      const node = fakeRpc(seasonChain({ markets: [], swaps: [] }))
      const starts: number[] = []
      const rpc = createRpc(RPC_URL, {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          starts.push(Date.now())
          return node.fetch(input, init)
        },
      })
      const calls = Promise.all(
        [1, 2, 3, 4, 5].map(() => rpc.call('getSignaturesForAddress', listSignatures())),
      )
      await vi.advanceTimersByTimeAsync(1000)
      await expect(calls).resolves.toEqual([[], [], [], [], []])
      expect(starts).toEqual([0, 250, 500, 750, 1000])
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits as many seconds as Retry-After says', async () => {
    const { rpc, node, retries } = setup(undefined, {
      wrap: withFaults([reply(429, { 'retry-after': '3' })]),
    })
    await expect(rpc.call('getSignaturesForAddress', listSignatures())).resolves.toEqual([])
    expect(node.requests.map((r) => r.at)).toEqual([0, 3000])
    expect(retries).toEqual([
      { method: 'getSignaturesForAddress', attempt: 1, waitMs: 3000, status: 429 },
    ])
  })

  // A date in the past waits 0 ms, so the retry starts at the next token, 250 ms after the first.
  it.each([
    ['5 s ahead', 5000, 5000, [0, 5000]],
    ['5 s in the past', -5000, 0, [0, 250]],
  ])('waits until the HTTP-date of Retry-After, %s', async (_name, offset, waitMs, starts) => {
    const start = Date.parse('2026-11-24T01:00:00Z')
    const date = new Date(start + offset).toUTCString()
    const { rpc, node, retries } = setup(undefined, {
      start,
      wrap: withFaults([reply(503, { 'retry-after': date })]),
    })
    await expect(rpc.call('getSignaturesForAddress', listSignatures())).resolves.toEqual([])
    expect(node.requests.map((r) => r.at - start)).toEqual(starts)
    expect(retries).toEqual([
      { method: 'getSignaturesForAddress', attempt: 1, waitMs, status: 503 },
    ])
  })

  it('backs off from 500 ms to 8 s without Retry-After, and retries network errors', async () => {
    const faults = [
      reply(500),
      reply(502),
      reply(503),
      reply(504),
      networkError(),
      reply(429),
      reply(429, { 'retry-after': 'soon' }),
      reply(500),
    ]
    const { rpc, clock, retries } = setup(undefined, { wrap: withFaults(faults) })
    await expect(rpc.call('getSignaturesForAddress', listSignatures())).resolves.toEqual([])
    expect(retries.map((r) => [r.attempt, r.waitMs, r.status])).toEqual([
      [1, 500, 500],
      [2, 1000, 502],
      [3, 2000, 503],
      [4, 4000, 504],
      [5, 8000, 'fetch failed (ECONNRESET)'],
      [6, 8000, 429],
      [7, 8000, 429],
      [8, 8000, 500],
    ])
    // The waits for the retries are the only sleeps: each one is longer than the token interval.
    expect(clock.sleeps).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000, 8000])
    expect(rpc.calls).toBe(9)
  })

  it.each<[string, () => Response | Error, string]>([
    ['HTTP 503', () => reply(503), '503'],
    ['a network error', networkError, 'fetch failed (ECONNRESET)'],
  ])('gives up after 8 retries of %s and names the method', async (_name, fault, status) => {
    const { rpc, node } = setup(undefined, { wrap: withFaults(Array.from({ length: 9 }, fault)) })
    await expect(rpc.call('getProgramAccounts', [HORAGON_PROGRAM_ID, {}])).rejects.toThrow(
      new Error(`getProgramAccounts failed after 8 retries (${status})`),
    )
    expect(node.requests).toHaveLength(9)
  })

  it('throws at once on a JSON-RPC error, naming the method and the code', async () => {
    const { rpc, node, retries } = setup()
    await expect(rpc.call('getBlockHeight', [])).rejects.toThrow(
      new Error('getBlockHeight failed: JSON-RPC error -32601: Method not found'),
    )
    expect(node.requests).toHaveLength(1)
    expect(retries).toEqual([])
  })

  it.each([
    ['HTTP 403', () => reply(403), 'getProgramAccounts failed: HTTP 403'],
    [
      'HTTP 401 with a JSON-RPC error',
      () =>
        reply(401, {}, '{"jsonrpc":"2.0","error":{"code":-32401,"message":"Unauthorized"},"id":1}'),
      'getProgramAccounts failed: JSON-RPC error -32401: Unauthorized',
    ],
    [
      'a body that is not JSON',
      () => reply(200, {}, '<html>busy</html>'),
      'getProgramAccounts failed: the response is not JSON',
    ],
    [
      'JSON without a result',
      () => reply(200, {}, '{"jsonrpc":"2.0","id":1}'),
      'getProgramAccounts failed: the response has no result',
    ],
  ])('throws at once on %s', async (_name, fault, message) => {
    const { rpc, node } = setup(undefined, { wrap: withFaults([fault()]) })
    await expect(rpc.call('getProgramAccounts', [HORAGON_PROGRAM_ID, {}])).rejects.toThrow(
      new Error(message),
    )
    expect(node.requests).toHaveLength(1)
  })

  it('retries a getTransaction that returns null 3 times, then gives up', async () => {
    const { rpc, node, retries } = setup()
    const signature = fakeSignature('never-landed')
    await expect(
      rpc.call('getTransaction', [
        signature,
        { encoding: 'json', maxSupportedTransactionVersion: 0 },
      ]),
    ).rejects.toThrow(new Error(`transaction ${signature} not available`))
    expect(node.requests).toHaveLength(4)
    expect(retries).toEqual(
      [500, 1000, 2000].map((waitMs, i) => ({
        method: 'getTransaction',
        attempt: i + 1,
        waitMs,
        status: 'null',
      })),
    )
  })

  it('returns a transaction that arrives after a null', async () => {
    const nullResult = '{"jsonrpc":"2.0","result":null,"id":1}'
    const { rpc, chain, clock } = setup(
      { markets: [M1], swaps: [['fan', 'm1', at(0), { tx: 'late' }]] },
      { wrap: withFaults([reply(200, {}, nullResult)]) },
    )
    await expect(
      rpc.call('getTransaction', [
        fakeSignature('late'),
        { encoding: 'json', maxSupportedTransactionVersion: 0 },
      ]),
    ).resolves.toEqual(chain.transactions[0])
    expect(clock.sleeps).toEqual([500])
  })

  it.each(incomplete)(
    'treats a getTransaction whose %s like null: 3 retries, then it gives up',
    async (_name, change) => {
      const { rpc, node, retries } = setup(
        { markets: [M1], swaps: [['fan', 'm1', at(0), { tx: 'partial' }]] },
        { wrap: changeTransactions(change) },
      )
      const signature = fakeSignature('partial')
      await expect(
        rpc.call('getTransaction', [
          signature,
          { encoding: 'json', maxSupportedTransactionVersion: 0 },
        ]),
      ).rejects.toThrow(new Error(`transaction ${signature} not available`))
      expect(node.requests).toHaveLength(4)
      expect(retries).toEqual(
        [500, 1000, 2000].map((waitMs, i) => ({
          method: 'getTransaction',
          attempt: i + 1,
          waitMs,
          status: 'null',
        })),
      )
    },
  )

  it.each(incomplete)(
    'returns a transaction that arrives in full after one whose %s',
    async (_name, change) => {
      const { rpc, chain, clock } = setup(
        { markets: [M1], swaps: [['fan', 'm1', at(0), { tx: 'late' }]] },
        { wrap: changeTransactions(change, 1) },
      )
      await expect(
        rpc.call('getTransaction', [
          fakeSignature('late'),
          { encoding: 'json', maxSupportedTransactionVersion: 0 },
        ]),
      ).resolves.toEqual(chain.transactions[0])
      expect(clock.sleeps).toEqual([500])
    },
  )

  /** A copy of the transaction whose meta.loadedAddresses is `loadedAddresses`. */
  const withLoaded =
    (loadedAddresses: unknown): TxChange =>
    (tx) => ({ ...tx, meta: { ...(tx.meta as Record<string, unknown>), loadedAddresses } })
  const withoutLoaded: TxChange = (tx) => ({
    ...tx,
    meta: without(tx.meta as Record<string, unknown>, 'loadedAddresses'),
  })

  /**
   * Answers whose meta.loadedAddresses does not hold the addresses that the lookups of a v0
   * transaction load: here one writable address, the market, and no readonly one.
   */
  const unresolved: [string, TxChange][] = [
    ['is missing', withoutLoaded],
    ['is null', withLoaded(null)],
    ['has no readonly list', withLoaded({ writable: [pmAmmMarketKey('m1')] })],
    ['is too short', withLoaded({ writable: [], readonly: [] })],
    ['is too long', withLoaded({ writable: [pmAmmMarketKey('m1'), walletKey('x')], readonly: [] })],
  ]

  it.each(unresolved)(
    'treats a lookup-table transaction whose loadedAddresses %s like null',
    async (_name, change) => {
      const { rpc, node, retries } = setup(
        { markets: [M1], swaps: [['fan', 'm1', at(0), { tx: 'lookup', lookup: true }]] },
        { wrap: changeTransactions(change) },
      )
      const signature = fakeSignature('lookup')
      await expect(
        rpc.call('getTransaction', [
          signature,
          { encoding: 'json', maxSupportedTransactionVersion: 0 },
        ]),
      ).rejects.toThrow(new Error(`transaction ${signature} not available`))
      expect(node.requests).toHaveLength(4)
      expect(retries.map((r) => [r.attempt, r.status])).toEqual([
        [1, 'null'],
        [2, 'null'],
        [3, 'null'],
      ])
    },
  )

  // addressTableLookups is [] in the first case and missing, as in a legacy message, in the second.
  it.each<[string, TxChange]>([
    ['loadedAddresses is missing', withoutLoaded],
    [
      'loadedAddresses and addressTableLookups are missing',
      (tx) => {
        const transaction = tx.transaction as Record<string, unknown>
        const message = transaction.message as Record<string, unknown>
        return {
          ...withoutLoaded(tx),
          transaction: { ...transaction, message: without(message, 'addressTableLookups') },
        }
      },
    ],
  ])('returns at once a transaction without lookup tables whose %s', async (_name, change) => {
    const { rpc, chain, retries } = setup(
      { markets: [M1], swaps: [['fan', 'm1', at(0), { tx: 'static' }]] },
      { wrap: changeTransactions(change) },
    )
    await expect(
      rpc.call('getTransaction', [
        fakeSignature('static'),
        { encoding: 'json', maxSupportedTransactionVersion: 0 },
      ]),
    ).resolves.toEqual(change(chain.transactions[0] as unknown as Record<string, unknown>))
    expect(retries).toEqual([])
  })
})

describe('fetchGameMarkets', () => {
  it('asks for GameMarket accounts with these exact parameters and decodes them', async () => {
    const season: Season = {
      markets: [M1, { ...M2, kind: 1, league: 'PRACTICE', game: 'p-0007' }],
      swaps: [],
    }
    const { rpc, node, chain } = setup(season)
    // A Config account of the same program, which the discriminator filter must leave out.
    chain.accounts.push({
      address: gameMarketKey('config'),
      data: gameMarketData({
        marketLabel: 'pm-amm/config',
        marketId: 0n,
        kind: 0,
        league: 'NBA',
        gameId: '',
        home: '',
        away: '',
        scheduledTipoff: 0,
        discriminator: DISCRIMINATORS.config,
      }),
    })
    await expect(fetchGameMarkets(rpc)).resolves.toEqual(records(season))
    expect(node.requests.map((r) => [r.method, r.params])).toEqual([
      [
        'getProgramAccounts',
        [
          HORAGON_PROGRAM_ID,
          {
            encoding: 'base64',
            commitment: 'confirmed',
            filters: [{ memcmp: { offset: 0, bytes: '6t71NUb8zXs' } }],
          },
        ],
      ],
    ])
  })
})

describe('fetchSignatures', () => {
  it('pages through 1,203 signatures with before and keeps the 1,200 that succeeded', async () => {
    const { pages } = bigMarket
    const { rpc, node } = setup(bigMarket.season)
    const address = pmAmmMarketKey(pages.market)
    const listed = node.signaturesFor(address)
    expect(listed).toHaveLength(pages.signatures)
    expect(listed.filter((s) => s.err !== null)).toHaveLength(pages.failed)
    // The last entry of the first page is a failed transaction.
    expect(listed[999]?.signature).toBe(fakeSignature(pages.secondPageBefore))
    expect(listed[999]?.err).not.toBeNull()

    const signatures = await fetchSignatures(rpc, address)
    expect(node.requests.map((r) => [r.method, ...r.params])).toEqual([
      ['getSignaturesForAddress', address, { limit: 1000, commitment: 'confirmed' }],
      [
        'getSignaturesForAddress',
        address,
        { limit: 1000, before: fakeSignature(pages.secondPageBefore), commitment: 'confirmed' },
      ],
    ])
    expect(signatures).toHaveLength(pages.signatures - pages.failed)
    expect(signatures).toEqual(listed.filter((s) => s.err === null).map((s) => s.signature))
  })

  it('asks once more after a page of exactly 1,000 and stops at the empty page', async () => {
    const { rpc, node } = setup({
      markets: [M1],
      swaps: [['fan', 'm1', at(0), { repeat: 1000, every: 30 }]],
    })
    const signatures = await fetchSignatures(rpc, pmAmmMarketKey('m1'))
    expect(signatures).toHaveLength(1000)
    expect(node.requests.map((r) => r.params[1])).toEqual([
      { limit: 1000, commitment: 'confirmed' },
      { limit: 1000, before: signatures[999], commitment: 'confirmed' },
    ])
  })

  it('makes one request for an address without transactions', async () => {
    const { rpc, node } = setup()
    await expect(fetchSignatures(rpc, pmAmmMarketKey('quiet'))).resolves.toEqual([])
    expect(node.requests).toHaveLength(1)
  })

  /** Sends every request on to the node, but changes the result of the calls to `method`. */
  const changeResult =
    (method: string, change: (result: unknown) => unknown) =>
    (serve: typeof fetch): typeof fetch =>
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await serve(input, init)
      if (JSON.parse(String(init?.body)).method !== method) return answer
      const body = await answer.json()
      return new Response(JSON.stringify({ ...body, result: change(body.result) }))
    }
  const oneSwap: Season = { markets: [M1], swaps: [['fan', 'm1', at(0)]] }

  it('throws on a page entry without err instead of dropping it', async () => {
    const { rpc } = setup(oneSwap, {
      wrap: changeResult('getSignaturesForAddress', (page) =>
        (page as Record<string, unknown>[]).map(({ err: _err, ...rest }) => rest),
      ),
    })
    await expect(fetchSignatures(rpc, pmAmmMarketKey('m1'))).rejects.toThrow(
      new Error(`getSignaturesForAddress returned a malformed entry for ${pmAmmMarketKey('m1')}`),
    )
  })

  it('throws on a full page whose last entry has no signature, and does not loop', async () => {
    const { rpc, node } = setup(
      { markets: [M1], swaps: [['fan', 'm1', at(0), { repeat: 1000, every: 30 }]] },
      {
        wrap: changeResult('getSignaturesForAddress', (page) =>
          (page as Record<string, unknown>[]).map((entry, i, all) =>
            i === all.length - 1 ? { ...entry, signature: undefined } : entry,
          ),
        ),
      },
    )
    await expect(fetchSignatures(rpc, pmAmmMarketKey('m1'))).rejects.toThrow(
      'getSignaturesForAddress returned a malformed entry',
    )
    expect(node.requests).toHaveLength(1)
  })

  it('throws when the page is not an array', async () => {
    const { rpc } = setup(oneSwap, {
      wrap: changeResult('getSignaturesForAddress', () => ({ signatures: [] })),
    })
    await expect(fetchSignatures(rpc, pmAmmMarketKey('m1'))).rejects.toThrow(
      new Error('getSignaturesForAddress failed: the result is not an array'),
    )
  })

  it('throws when the GameMarket list is not an array', async () => {
    const { rpc } = setup(oneSwap, {
      wrap: changeResult('getProgramAccounts', () => null),
    })
    await expect(fetchGameMarkets(rpc)).rejects.toThrow(
      new Error('getProgramAccounts failed: the result is not an array'),
    )
  })
})

describe('fetchSwaps', () => {
  it('fetches each successful transaction once, also one that touches two markets', async () => {
    const season: Season = {
      markets: [M1, M2],
      swaps: [
        ['fan', 'm1', at(0), { tx: 'both', sponsored: true }],
        ['fan', 'm2', at(0), { tx: 'both' }],
        ['fan', 'm1', at(60), { tx: 'later' }],
        ['other', 'm2', at(120), { tx: 'failed', failed: true }],
      ],
    }
    const { rpc, node } = setup(season)
    const progress: [number, number][] = []
    const swaps = await fetchSwaps(rpc, records(season), (done, total) =>
      progress.push([done, total]),
    )
    const swap = (tx: string, market: string, seconds: number) => ({
      signature: fakeSignature(tx),
      wallet: walletKey('fan'),
      market: pmAmmMarketKey(market),
      blockTime: T + seconds,
      botMemo: false,
    })
    expect(swaps).toEqual([swap('later', 'm1', 60), swap('both', 'm1', 0), swap('both', 'm2', 0)])
    expect(node.requests.filter((r) => r.method === 'getTransaction').map((r) => r.params)).toEqual(
      ['later', 'both'].map((tx) => [
        fakeSignature(tx),
        { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
      ]),
    )
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ])
  })

  it('reads the 1,202 swaps of the fixture and never asks for a failed transaction', {
    timeout: 30_000,
  }, async () => {
    const { rpc, node } = setup(bigMarket.season)
    const failed = new Set(
      node
        .signaturesFor(pmAmmMarketKey(bigMarket.pages.market))
        .filter((s) => s.err !== null)
        .map((s) => s.signature),
    )
    const swaps = await fetchSwaps(rpc, records(bigMarket.season))
    const asked = node.requests
      .filter((r) => r.method === 'getTransaction')
      .map((r) => String(r.params[0]))
    expect(swaps).toHaveLength(1202)
    expect(asked).toHaveLength(1202)
    expect(new Set(asked).size).toBe(1202)
    expect(failed.size).toBe(3)
    expect(asked.filter((s) => failed.has(s))).toEqual([])
  })
})

describe('golden devnet responses', () => {
  // The two getTransaction responses of the contract, saved byte for byte as devnet sent them.
  const golden = [
    {
      file: 'rpc-swap-unsponsored.json',
      signature:
        'dBvPN4uJhdZAGeoTWxZJNSkUCgVa5Cd2iuKi2QvYCD8Z6xEqsovLxQNoQN4t8Hn5er3GRbs2Z1APwXTv4y7HgGA',
      wallet: 'BqwvXe6H4ZgCgg6D2dSDVFkCrN79X8C6ZC6RDXB5soo',
      feePayer: 'BqwvXe6H4ZgCgg6D2dSDVFkCrN79X8C6ZC6RDXB5soo',
      signers: 1,
      market: 'JBEvyrW6w6bbcGFnUuNdN5AdNBayiBRB4ggoFmX5D4tH',
      blockTime: 1794993225,
    },
    {
      file: 'rpc-swap-sponsored.json',
      signature:
        '5Pu68wzGKErA74ggUXS5UwE4Aov73RpSEvrEueBKCtTHZb4x6geA6Y7tZmZ3NvKBkJLKQ8psKK8MJqGa86cY2jBV',
      wallet: '9qbjWVkoA4Z9SSieAcBnzG8K4zj8F3M955w7spAjK2XW',
      feePayer: '32tQ3JDbnnQSqs51BDNzgcy82dW7AKK2EMKDo9ACBnrc',
      signers: 2,
      market: 'qpF2PseRguMvq4bK1jbWodfCapfCPFmrYcrNjMYj4AK',
      blockTime: 1794994260,
    },
  ]

  /** A node with one market and one transaction, whose getTransaction body is `body` verbatim. */
  const goldenNode =
    (market: string, signature: string, body: string) =>
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { id, method, params } = JSON.parse(String(init?.body))
      if (method === 'getTransaction' && params[0] === signature) return new Response(body)
      const entry = { signature, slot: 0, err: null, memo: null, blockTime: 0 }
      const result = method === 'getSignaturesForAddress' && params[0] === market ? [entry] : null
      return new Response(JSON.stringify({ jsonrpc: '2.0', result, id }))
    }

  it.each(golden)('$file decodes to the trader and its market', async (g) => {
    const body = fixture(g.file)
    const tx = (JSON.parse(body) as { result: RawTransaction }).result
    expect(tx.transaction.signatures[0]).toBe(g.signature)
    expect(tx.transaction.message.accountKeys[0]).toBe(g.feePayer)
    expect(tx.transaction.message.header.numRequiredSignatures).toBe(g.signers)
    const clock = fakeClock()
    const rpc = createRpc(RPC_URL, {
      fetch: goldenNode(g.market, g.signature, body),
      now: clock.now,
      sleep: clock.sleep,
    })
    const record: GameMarketRecord = {
      address: gameMarketKey('golden'),
      market: g.market,
      kind: 0,
      league: 'NBA',
      gameId: '401810300',
      scheduledTipoff: unix('2026-11-24T19:00:00-05:00'),
    }
    await expect(fetchSwaps(rpc, [record])).resolves.toEqual([
      {
        signature: g.signature,
        wallet: g.wallet,
        market: g.market,
        blockTime: g.blockTime,
        botMemo: false,
      },
    ])
  })

  it('are the raw bodies, and hold the transactions of devnet-swaps.json', () => {
    const devnet = JSON.parse(fixture('devnet-swaps.json')) as Record<'s1' | 's3a', RawTransaction>
    const unsponsored = fixture('rpc-swap-unsponsored.json')
    const sponsored = fixture('rpc-swap-sponsored.json')
    for (const body of [unsponsored, sponsored]) {
      expect(body).toMatch(/^\{"jsonrpc":"2\.0","result":\{"blockTime":\d+,.*\},"id":1\}\n$/)
    }
    // JSON.parse turns 980.0 into 980; the raw body keeps what the node sent.
    expect(unsponsored).toContain('"uiAmount":980.0,')
    expect(JSON.parse(unsponsored).result).toEqual(devnet.s1)
    expect(JSON.parse(sponsored).result).toEqual(devnet.s3a)
  })
})
