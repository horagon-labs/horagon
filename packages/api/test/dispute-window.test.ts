import type { Connection } from '@solana/web3.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { challengeEndsAt, disputeWindowReader } from '../src/dispute-window'
import { configAccount } from './config-account'
import { program } from './helpers'

/** A connection whose getAccountInfo answers from `answer`, counting calls. */
function chain(answer: () => Promise<unknown>) {
  const calls = { n: 0 }
  const connection = {
    async getAccountInfo() {
      calls.n++
      return answer()
    },
  } as unknown as Connection
  return { calls, deps: { program, connection } }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('disputeWindowReader (the on-chain window, never guessed)', () => {
  it('reads Config.disputeWindowSecs and keeps a success for 600 s', async () => {
    vi.useFakeTimers({ now: 0 })
    const c = chain(async () => configAccount(900))
    const read = disputeWindowReader(c.deps)
    expect(await read()).toBe(900)
    vi.setSystemTime(599_999)
    expect(await read()).toBe(900)
    expect(c.calls.n).toBe(1)
    vi.setSystemTime(600_000)
    expect(await read()).toBe(900)
    expect(c.calls.n).toBe(2)
  })

  it('shares one read between callers that ask at once', async () => {
    const c = chain(async () => configAccount(900))
    const read = disputeWindowReader(c.deps)
    expect(await Promise.all([read(), read(), read()])).toEqual([900, 900, 900])
    expect(c.calls.n).toBe(1)
  })

  it('answers null when the read fails or finds no Config, and does not keep it', async () => {
    let fail = true
    const c = chain(async () => {
      if (fail) throw new Error('fetch failed')
      return null
    })
    const read = disputeWindowReader(c.deps)
    expect(await read()).toBeNull()
    fail = false
    expect(await read()).toBeNull()
    expect(c.calls.n).toBe(2)
  })

  it('gives up after 1 s with null, and asks again next time', async () => {
    vi.useFakeTimers({ now: 0 })
    let slow = true
    const c = chain(() =>
      slow ? new Promise(() => undefined) : Promise.resolve(configAccount(600)),
    )
    const read = disputeWindowReader(c.deps)
    const first = read()
    await vi.advanceTimersByTimeAsync(999)
    let settled = false
    void first.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await first).toBeNull()
    slow = false
    expect(await read()).toBe(600)
  })

  it('keeps one cache per reader: a second app reads for itself', async () => {
    const c = chain(async () => configAccount(900))
    await disputeWindowReader(c.deps)()
    await disputeWindowReader(c.deps)()
    expect(c.calls.n).toBe(2)
  })
})

describe('challengeEndsAt', () => {
  const at = new Date('2026-11-29T05:00:00Z')
  const secs = at.getTime() / 1000

  it('is proposed_at plus the window while the result is proposed', () => {
    expect(challengeEndsAt('proposed', at, 900)).toBe(secs + 900)
  })

  it('is null when the window or proposed_at is unknown, never 900 by default', () => {
    expect(challengeEndsAt('proposed', at, null)).toBeNull()
    expect(challengeEndsAt('proposed', null, 900)).toBeNull()
  })

  it('is null in every other state', () => {
    for (const s of ['open', 'halted', 'challenged', 'finalized', 'recycled']) {
      expect(challengeEndsAt(s, at, 900), s).toBeNull()
    }
  })
})
