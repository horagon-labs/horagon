import { Buffer } from 'node:buffer'
import { HoragonError, PM_AMM_PROGRAM_ID } from '@horagon/sdk'
import { type AccountInfo, type Connection, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { ChainReader, MAX_KEYS_PER_CALL, RPC_DOWN_HINT, rpc, tokenAmount } from '../src/chain'
import { ApiError, problemBody } from '../src/problem'
import { s1Market } from './helpers'

const keys = (n: number) => Array.from({ length: n }, () => PublicKey.unique())
const info = (key: PublicKey): AccountInfo<Buffer> => ({
  data: Buffer.from(key.toBytes()),
  owner: PublicKey.default,
  lamports: 1,
  executable: false,
  rentEpoch: 0,
})

/** Like a real RPC: getMultipleAccounts refuses more than 100 keys. */
function multiConnection() {
  const calls: number[] = []
  const connection = {
    async getMultipleAccountsInfo(ks: PublicKey[]) {
      calls.push(ks.length)
      if (ks.length > MAX_KEYS_PER_CALL) throw new Error('Too many inputs provided; max 100')
      return ks.map(info)
    },
  } as unknown as Connection
  return { connection, calls }
}

describe('ChainReader.accounts', () => {
  it.each([
    [0, []],
    [100, [100]],
    [101, [100, 1]],
    [250, [100, 100, 50]],
  ])('reads %i keys in slices of at most 100, in input order', async (n, slices) => {
    const { connection, calls } = multiConnection()
    const ks = keys(n)
    const out = await new ChainReader(connection).accounts(ks)
    expect(calls).toEqual(slices)
    expect(out.map((a) => (a ? new PublicKey(a.data).toBase58() : null))).toEqual(
      ks.map((k) => k.toBase58()),
    )
  })
})

describe('ChainReader.market', () => {
  it('shares one getAccountInfo between simultaneous misses and retries after a failure', async () => {
    const m = s1Market(0)
    let calls = 0
    let fail = true
    const connection = {
      async getAccountInfo() {
        calls++
        await new Promise((r) => setTimeout(r, 5))
        if (fail) throw new Error('fetch failed')
        return { data: m.data, owner: PM_AMM_PROGRAM_ID, lamports: 1, executable: false }
      },
    } as unknown as Connection
    const chain = new ChainReader(connection)
    const failed = await Promise.allSettled([chain.market(m.pubkey), chain.market(m.pubkey)])
    expect(failed.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(calls).toBe(1)
    fail = false
    const [a, b] = await Promise.all([chain.market(m.pubkey), chain.market(m.pubkey)])
    expect(calls).toBe(2)
    expect(a.marketId).toBe(m.decoded.marketId)
    expect(b).toBe(a)
  })
})

describe('rpc', () => {
  it('turns a transport failure into NETWORK, keeping the cause out of the problem body', async () => {
    const cause = new Error('fetch failed: https://rpc.example/?api-key=SECRET')
    const err = await rpc('getSlot', () => Promise.reject(cause)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'NETWORK', cause, extra: { status: 502, cause } })
    const body = problemBody(err, 'rid')
    expect(body).toMatchObject({ status: 502, code: 'NETWORK', hint: RPC_DOWN_HINT })
    expect(JSON.stringify(body)).not.toMatch(/SECRET|rpc\.example|fetch failed/)
  })

  it('lets ApiErrors and HoragonErrors through unchanged', async () => {
    const api = new ApiError('NOT_FOUND', 'gone')
    const sdk = new HoragonError('MAINNET_DISABLED', 'mainnet')
    await expect(rpc('a', () => Promise.reject(api))).rejects.toBe(api)
    await expect(rpc('b', () => Promise.reject(sdk))).rejects.toBe(sdk)
    await expect(rpc('c', async () => 7)).resolves.toBe(7)
  })
})

describe('tokenAmount', () => {
  it('reads u64 LE at byte 64, and 0 for a missing or short account', () => {
    const data = Buffer.alloc(165)
    data.writeBigUInt64LE(1_234_567n, 64)
    const base = { owner: PublicKey.default, lamports: 1, executable: false, rentEpoch: 0 }
    expect(tokenAmount({ ...base, data })).toBe(1_234_567n)
    expect(tokenAmount(null)).toBe(0n)
    expect(tokenAmount({ ...base, data: Buffer.alloc(71) })).toBe(0n)
  })
})
