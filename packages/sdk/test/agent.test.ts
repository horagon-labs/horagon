import { describe, expect, it } from 'vitest'
import { REFERENCE_AGENT_WALLET } from '../src'
import {
  GameActivitySchema,
  GameDetailSchema,
  PubkeySchema,
  TradeTallySchema,
} from '../src/schemas'

const tally = { swaps: 12, wallets: 1, volumeUsdc: '840' }
const activity = {
  agent: { ...tally, wallet: REFERENCE_AGENT_WALLET },
  fans: { swaps: 3, wallets: 2, volumeUsdc: '45.5' },
  others: { swaps: 0, wallets: 0, volumeUsdc: '0' },
  lastFanTradeTs: 1_795_000_000,
  lastAgentTradeTs: null,
}

describe('the reference agent (R2b)', () => {
  it('exports the disclosed wallet from the index, a valid public key', () => {
    expect(REFERENCE_AGENT_WALLET).toBe('7Da24CpktL9Cp4st1iQ3U4ZKHgsRYXXEJx5oGbgFWP1Z')
    expect(PubkeySchema.safeParse(REFERENCE_AGENT_WALLET).success).toBe(true)
  })

  it('reads a tally: whole counts and a decimal volume', () => {
    expect(TradeTallySchema.parse(tally)).toEqual(tally)
    for (const bad of [
      { ...tally, swaps: -1 },
      { ...tally, wallets: 1.5 },
      { ...tally, volumeUsdc: '-1' },
      { ...tally, volumeUsdc: 840 },
    ]) {
      expect(TradeTallySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('reads a game activity, with the agent wallet and nullable last-trade times', () => {
    expect(GameActivitySchema.parse(activity)).toEqual(activity)
    const { wallet: _wallet, ...noWallet } = activity.agent
    expect(GameActivitySchema.safeParse({ ...activity, agent: noWallet }).success).toBe(false)
    expect(GameActivitySchema.safeParse({ ...activity, lastFanTradeTs: undefined }).success).toBe(
      false,
    )
  })

  it('requires the activity on a game detail', () => {
    expect(GameDetailSchema.shape).toHaveProperty('activity', GameActivitySchema)
  })
})
