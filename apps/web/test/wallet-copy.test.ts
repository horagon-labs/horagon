import { describe, expect, it } from 'vitest'
import { readyHint, replacePrompt, WALLET_READY } from '../lib/wallet-copy'

describe('replacePrompt (fix M5)', () => {
  it('says the old key stays on this device when storage works', () => {
    expect(replacePrompt(false)).toBe(
      'Replace this wallet? Its key stays saved on this device, but Horagon will not show it again. Export it first (Show secret key) if it holds anything you want to keep.',
    )
  })

  it('says the old key lasts only for this tab when storage is blocked', () => {
    expect(replacePrompt(true)).toBe(
      'Replace this wallet? Storage is blocked in this browser, so its key is kept only until you close this tab. Export it first (Show secret key) if it holds anything you want to keep.',
    )
  })
})

describe('readyHint (fix M3)', () => {
  it('points a wallet created here to the faucet while it holds no mUSDC', () => {
    expect(WALLET_READY).toBe('Your play wallet is ready. Get play mUSDC from the faucet to start.')
    expect(readyHint(true, undefined)).toBe(WALLET_READY)
    expect(readyHint(true, null)).toBe(WALLET_READY)
    expect(readyHint(true, '0')).toBe(WALLET_READY)
    expect(readyHint(true, '0.000000')).toBe(WALLET_READY)
  })

  it('says nothing once the wallet holds mUSDC, or for a wallet not created here', () => {
    expect(readyHint(true, '0.000001')).toBeNull()
    expect(readyHint(true, '1000')).toBeNull()
    expect(readyHint(false, '0')).toBeNull()
    expect(readyHint(false, undefined)).toBeNull()
  })
})
