import { describe, expect, it, vi } from 'vitest'
import { type FaucetClient, requestFunds } from '../lib/faucet'

describe('requestFunds', () => {
  it('asks the faucet for the wallet and words the amount', async () => {
    const faucet = vi.fn(async () => ({ signature: null, amountUsdc: '100' }))
    expect(await requestFunds({ faucet } as FaucetClient, 'W1')).toBe('Added 100.00 play mUSDC.')
    expect(faucet).toHaveBeenCalledWith('W1')
  })

  it('lets the API error through for the caller to show', async () => {
    const c = {
      faucet: async () => {
        throw new Error('limit')
      },
    } as unknown as FaucetClient
    await expect(requestFunds(c, 'W1')).rejects.toThrow('limit')
  })
})
