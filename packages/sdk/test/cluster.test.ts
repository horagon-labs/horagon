import { describe, expect, it } from 'vitest'
import { assertNotMainnetGenesis, HoragonError, MAINNET_GENESIS_HASH } from '../src'

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const rpcWith = (genesis: string) => ({ getGenesisHash: async () => genesis })

describe('assertNotMainnetGenesis', () => {
  it("refuses an RPC that reports mainnet's genesis hash", async () => {
    expect(MAINNET_GENESIS_HASH).toBe('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
    const err = await assertNotMainnetGenesis(rpcWith(MAINNET_GENESIS_HASH)).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(HoragonError)
    expect(err).toMatchObject({ code: 'MAINNET_DISABLED' })
  })

  it('accepts devnet and any other cluster', async () => {
    await expect(assertNotMainnetGenesis(rpcWith(DEVNET_GENESIS_HASH))).resolves.toBeUndefined()
  })

  it('rethrows an RPC failure as it is', async () => {
    const failure = new Error('fetch failed')
    const rpc = { getGenesisHash: () => Promise.reject(failure) }
    await expect(assertNotMainnetGenesis(rpc)).rejects.toBe(failure)
  })
})
