// The indexer under an IndexPace (incident of 2026-11-25): a rate limit stops the pass and holds
// the next ones, a market is asked for its signatures only when its account or mints changed or
// its sweep is due, and signature reads are spaced. Chain calls are fakes on a fake clock.
import { type DbHandle, upsertMarket, upsertScheduledGames } from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import { DEVNET_MUSDC_MINT, HoragonProgram } from '@horagon/sdk'
import { Keypair, type PublicKey } from '@solana/web3.js'
import type { Logger } from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IndexPace, SIGNATURES_SPACING_MS } from '../src/index-pace'
import { type IndexerDeps, indexOnce, STUCK_AFTER } from '../src/indexer'

// Market accounts are not decoded for real: the first data byte 1 is a price of 0.4.
vi.mock('@horagon/sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@horagon/sdk')>()
  return {
    ...real,
    decodeMarketAccount: (info: { data: Uint8Array }) => ({
      price: info.data[0] === 1 ? 0.4 : null,
    }),
    liveMarket: (m: { price: number | null }) => ({ price: m.price, liquidity: 0, closed: false }),
  }
})

const RATE_LIMIT = () =>
  new Error(
    '429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests for a specific RPC call"}}',
  )
const START = Date.parse('2026-11-28T00:00:00Z')

describe('indexOnce with an IndexPace', () => {
  const program = new HoragonProgram({ collateralMint: DEVNET_MUSDC_MINT })
  let h: DbHandle
  /** The fake wall clock in ms; the keeper's `now` reads it in seconds. */
  let t: number
  let pace: IndexPace
  /** Each account's data (markets and their outcome mints); a key not here has no account. */
  let data: Map<string, Uint8Array>
  /** Each market's outcome mints. */
  let mints: Map<string, { yes: string; no: string }>
  /** getSignaturesForAddress calls: the market and the clock. */
  let sigCalls: Array<{ market: string; at: number }>
  let accountCalls: number[]
  let txCalls: number
  /** Each getSignaturesForAddress answer; a function may throw. */
  let sigAnswer: (market: string) => Array<{ signature: string; err: null }>
  let accountAnswer: () => void
  let txAnswer: () => void
  let warns: Array<{ obj: Record<string, unknown>; msg: string }>
  let sent: Array<{ key: string; text: string }>

  const log = () =>
    ({
      warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }),
      info: () => {},
      debug: () => {},
    }) as unknown as Logger
  const alerts = () => ({
    send: async (key: string, text: string) => {
      sent.push({ key, text })
    },
  })
  const deps = (): IndexerDeps => ({
    db: h.db,
    collateralMint: DEVNET_MUSDC_MINT,
    authority: program.authority,
    alerts: alerts(),
    log: log(),
    now: () => Math.floor(t / 1000),
    stops: new Map(),
    pace,
    connection: {
      getSignaturesForAddress: async (a: PublicKey) => {
        sigCalls.push({ market: a.toBase58(), at: t })
        return sigAnswer(a.toBase58())
      },
      getTransactions: async (sigs: string[]) => {
        txCalls++
        txAnswer()
        return sigs.map(() => null)
      },
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        accountCalls.push(keys.length)
        accountAnswer()
        return keys.map((k) => {
          const d = data.get(k.toBase58())
          return d ? { owner: program.authority, data: d } : null
        })
      },
    } as unknown as IndexerDeps['connection'],
  })

  async function addMarket(status: 'open' | 'halted' | 'resolved' | 'recycled', i: number) {
    const pubkey = Keypair.generate().publicKey.toBase58()
    const yesMint = Keypair.generate().publicKey.toBase58()
    const noMint = Keypair.generate().publicKey.toBase58()
    await upsertMarket(h.db, {
      pubkey,
      gameId: 'nba-1',
      kind: 0,
      marketId: `${status}-${i}`,
      gameMarketPda: Keypair.generate().publicKey.toBase58(),
      yesMint,
      noMint,
      initialPriceBps: 5000,
      // Open markets end later; the others ended an hour ago.
      endTs: new Date(status === 'open' ? START + 7_200_000 + i : START - 3_600_000 + i),
      seedAmount: 1_000_000n,
      status,
      ...(status === 'recycled' ? { recycledAt: new Date(START - 1_800_000) } : {}),
    })
    data.set(pubkey, Uint8Array.of(1, i))
    // A mint's data: its supply, here one byte.
    data.set(yesMint, Uint8Array.of(10))
    data.set(noMint, Uint8Array.of(10))
    mints.set(pubkey, { yes: yesMint, no: noMint })
    return pubkey
  }
  const asked = () => sigCalls.map((c) => c.market)

  beforeEach(async () => {
    h = await createTestDb()
    t = START
    data = new Map()
    mints = new Map()
    sigCalls = []
    accountCalls = []
    txCalls = 0
    warns = []
    sent = []
    sigAnswer = () => []
    accountAnswer = () => {}
    txAnswer = () => {}
    pace = new IndexPace({
      log: log(),
      alerts: alerts(),
      clock: () => t,
      random: () => 0,
      sleep: async (ms) => {
        t += ms
      },
    })
    await upsertScheduledGames(h.db, [
      {
        id: 'nba-1',
        league: 'NBA',
        externalId: '1',
        gameDate: '2026-11-27',
        home: 'WAS',
        away: 'MEM',
        scheduledTipoff: new Date(START),
        status: 'scheduled',
        p0: 0.5,
      },
    ])
  })
  afterEach(async () => {
    await h.close()
  })

  it('asks every market once on the first pass, then only a changed one or one due a sweep', async () => {
    const open = await addMarket('open', 0)
    const halted = await addMarket('halted', 1)
    const recycled = await addMarket('recycled', 2)
    await indexOnce(deps())
    expect(asked().sort()).toEqual([open, halted, recycled].sort())
    // One account read (each market and its two mints) covers indexing and the open price.
    expect(accountCalls).toEqual([9])

    // 5 s later nothing changed: no signature read at all.
    sigCalls = []
    t += 5_000
    await indexOnce(deps())
    expect(asked()).toEqual([])
    expect(accountCalls).toHaveLength(2)

    // A swap on the halted market's account (say a late withdrawal): only it is asked.
    data.set(halted, Uint8Array.of(1, 99))
    t += 5_000
    await indexOnce(deps())
    expect(asked()).toEqual([halted])
  })

  it('asks a resolved market on the next pass after a claim or redeem burns its shares', async () => {
    const resolved = await addMarket('resolved', 0)
    const other = await addMarket('resolved', 1)
    await indexOnce(deps())
    // claim_winnings and redeem_pair leave the market account as it was but burn shares: the
    // outcome mints' supply changes, read in the same account call.
    const m = mints.get(resolved)
    if (!m) throw new Error('no mints')
    data.set(m.yes, Uint8Array.of(7))
    sigCalls = []
    t += 5_000
    await indexOnce(deps())
    expect(asked()).toEqual([resolved])
    expect(accountCalls).toEqual([6, 6])
    // A redeem burns both; the other market is asked the same way.
    const o = mints.get(other)
    if (!o) throw new Error('no mints')
    data.set(o.yes, Uint8Array.of(9))
    data.set(o.no, Uint8Array.of(9))
    sigCalls = []
    t += 5_000
    await indexOnce(deps())
    expect(asked()).toEqual([other])
    // Unchanged after: nothing is asked.
    sigCalls = []
    t += 5_000
    await indexOnce(deps())
    expect(asked()).toEqual([])
  })

  it('sweeps an open market every 60 s and a closed one every 5 min, unchanged', async () => {
    const open = await addMarket('open', 0)
    const resolved = await addMarket('resolved', 1)
    const recycled = await addMarket('recycled', 2)
    await indexOnce(deps())
    const pass = async (atSecs: number) => {
      sigCalls = []
      t = START + atSecs * 1000
      await indexOnce(deps())
      return asked().sort()
    }
    const closed = (keys: string[]) => keys.filter((k) => k !== open)
    expect(await pass(55)).toEqual([])
    expect(await pass(60)).toEqual([open])
    expect(await pass(65)).toEqual([])
    expect(await pass(115)).toEqual([])
    expect(await pass(120)).toEqual([open])
    expect(closed(await pass(295))).toEqual([])
    expect(closed(await pass(300))).toEqual([resolved, recycled].sort())
    expect(await pass(305)).toEqual([])
  })

  it('spaces signature reads at least SIGNATURES_SPACING_MS apart within a pass', async () => {
    for (let i = 0; i < 5; i++) await addMarket('open', i)
    await indexOnce(deps())
    expect(sigCalls).toHaveLength(5)
    const gaps = sigCalls.slice(1).map((c, i) => c.at - (sigCalls[i]?.at ?? 0))
    expect(gaps.every((g) => g >= SIGNATURES_SPACING_MS)).toBe(true)
  })

  it('reads accounts in chunks of 100 keys and leaves the markets past the pass budget for the next pass, first', async () => {
    const keys: string[] = []
    for (let i = 0; i < 150; i++) keys.push(await addMarket('halted', i))
    await indexOnce(deps())
    // 150 markets and their 300 mints.
    expect(accountCalls).toEqual([100, 100, 100, 100, 50])
    // 350 ms apart, no market is started 3 s into the pass.
    const first = asked()
    expect(first).toHaveLength(10)
    sigCalls = []
    t += 5_000
    await indexOnce(deps())
    const second = asked()
    expect(second).toHaveLength(10)
    expect(second.filter((k) => first.includes(k))).toEqual([])
  }, 60_000)

  it('stops the pass on a rate-limited signature read and holds every read for the back-off', async () => {
    const a = await addMarket('open', 0)
    const b = await addMarket('open', 1)
    const c = await addMarket('open', 2)
    sigAnswer = (m) => {
      if (m === b) throw RATE_LIMIT()
      return []
    }
    await indexOnce(deps())
    expect(asked()).toEqual([a, b])
    const pauses = warns.filter((w) => w.msg.includes('pausing'))
    expect(pauses).toHaveLength(1)
    expect(pauses[0]?.obj).toMatchObject({ source: 'index', delayMs: 30_000 })
    expect(warns.some((w) => w.msg === 'index failed')).toBe(false)

    // Held: no RPC call of any kind for 30 s.
    sigCalls = []
    const accountsBefore = accountCalls.length
    for (let s = 5; s < 30; s += 5) {
      t = START + s * 1000
      expect(await indexOnce(deps())).toMatchObject({ paused: true })
    }
    expect(sigCalls).toEqual([])
    expect(accountCalls).toHaveLength(accountsBefore)
    expect(warns.filter((w) => w.msg.includes('pausing'))).toHaveLength(1)

    // Then b and c are asked (b was not indexed, c never reached), a is not: it did not change.
    // The pause runs from b's read, SIGNATURES_SPACING_MS into the first pass.
    t = START + 30_000
    expect(await indexOnce(deps())).toMatchObject({ paused: true })
    sigAnswer = () => []
    t = START + 30_000 + SIGNATURES_SPACING_MS
    await indexOnce(deps())
    expect(asked().sort()).toEqual([b, c].sort())
  })

  it('grows the pause on each rate-limited pass and starts it over after a clean one', async () => {
    await addMarket('open', 0)
    const delays = () =>
      warns.filter((w) => w.msg.includes('pausing')).map((w) => w.obj.delayMs as number)
    sigAnswer = () => {
      throw RATE_LIMIT()
    }
    await indexOnce(deps())
    t += 30_000
    await indexOnce(deps())
    t += 60_000
    await indexOnce(deps())
    expect(delays()).toEqual([30_000, 60_000, 120_000])
    t += 120_000
    sigAnswer = () => []
    await indexOnce(deps())
    sigAnswer = () => {
      throw RATE_LIMIT()
    }
    t += 60_000
    await indexOnce(deps())
    expect(delays()).toEqual([30_000, 60_000, 120_000, 30_000])
  })

  it('pauses on a rate-limited account read without asking for signatures', async () => {
    await addMarket('open', 0)
    accountAnswer = () => {
      throw RATE_LIMIT()
    }
    await indexOnce(deps())
    expect(sigCalls).toEqual([])
    expect(warns.filter((w) => w.msg.includes('pausing'))).toHaveLength(1)
    t += 10_000
    accountAnswer = () => {}
    expect(await indexOnce(deps())).toMatchObject({ paused: true })
    expect(accountCalls).toHaveLength(1)
  })

  it('pauses on a rate-limited transaction batch, keeping the stop, and asks the market again after', async () => {
    const a = await addMarket('open', 0)
    const b = await addMarket('open', 1)
    sigAnswer = (m) => (m === a ? [{ signature: 's1', err: null }] : [])
    txAnswer = () => {
      throw RATE_LIMIT()
    }
    await indexOnce(deps())
    expect(txCalls).toBe(1)
    expect(asked()).toEqual([a])
    expect(warns.filter((w) => w.msg.includes('pausing'))).toHaveLength(1)
    expect(warns.some((w) => w.msg === 'transaction batch read failed')).toBe(true)
    t += 30_000
    sigCalls = []
    txAnswer = () => {}
    sigAnswer = () => []
    await indexOnce(deps())
    expect(asked().sort()).toEqual([a, b].sort())
  })

  it('pages index-rate-limited, deduped by its key, once the pause streak passes 15 min', async () => {
    await addMarket('open', 0)
    sigAnswer = () => {
      throw RATE_LIMIT()
    }
    // A pass every 5 s for 20 min, every read rate-limited.
    for (let s = 0; s <= 1_200; s += 5) {
      t = START + s * 1000
      await indexOnce(deps())
    }
    expect(new Set(sent.map((x) => x.key))).toEqual(new Set(['index-rate-limited']))
    const first = sent[0]
    expect(first).toBeDefined()
    expect(first?.text).toMatch(/for 1[5-9] min/)
  })

  it('counts a signature list that keeps failing toward index-stuck, not a rate limit', async () => {
    const m = await addMarket('halted', 0)
    sigAnswer = () => {
      throw new Error('fetch failed')
    }
    const stops = new Map()
    for (let i = 0; i < STUCK_AFTER; i++) {
      await indexOnce({ ...deps(), stops })
      t += 5_000
    }
    expect(sent.map((x) => x.key)).toEqual([`index-stuck:${m}`])
    expect(sent[0]?.text).toContain('signature list')
    expect(warns.filter((w) => w.msg.includes('pausing'))).toEqual([])
    // Readable again: the counter goes.
    sigAnswer = () => []
    await indexOnce({ ...deps(), stops })
    expect(stops.has(m)).toBe(false)
  })
})
