import { describe, expect, it } from 'vitest'
import { createPoller } from '../lib/poller'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup() {
  const calls: ReturnType<typeof deferred<number>>[] = []
  const got: number[] = []
  const errors: Error[] = []
  const poller = createPoller<number>(
    () => {
      const d = deferred<number>()
      calls.push(d)
      return d.promise
    },
    { data: (v) => got.push(v), error: (e) => errors.push(e) },
  )
  return { calls, got, errors, poller }
}

describe('createPoller', () => {
  it('drops a late older answer after a newer one', async () => {
    const { calls, got, poller } = setup()
    const first = poller.run()
    const second = poller.run()
    calls[1]?.resolve(2)
    await second
    calls[0]?.resolve(1)
    await first
    expect(got).toEqual([2])
  })

  it('skips ticks while a run is in flight and resumes after it', async () => {
    const { calls, got, poller } = setup()
    const first = poller.run()
    await poller.tick()
    await poller.tick()
    expect(calls).toHaveLength(1)
    calls[0]?.resolve(1)
    await first
    const next = poller.tick()
    expect(calls).toHaveLength(2)
    calls[1]?.resolve(2)
    await next
    expect(got).toEqual([1, 2])
  })

  it('drops answers and errors from before a reset, and frees the next tick', async () => {
    const { calls, got, errors, poller } = setup()
    const a = poller.run()
    poller.reset()
    calls[0]?.resolve(1)
    await a
    const b = poller.tick()
    expect(calls).toHaveLength(2)
    poller.reset()
    calls[1]?.reject(new Error('late'))
    await b
    expect(got).toEqual([])
    expect(errors).toEqual([])
  })

  it('refresh and tick do nothing while there is no key (R7)', async () => {
    let enabled = false
    const calls: number[] = []
    const poller = createPoller<number>(
      async () => {
        calls.push(1)
        return 1
      },
      { data: () => {}, error: () => {} },
      () => enabled,
    )
    await poller.refresh()
    await poller.tick()
    expect(calls).toHaveLength(0)
    enabled = true
    await poller.refresh()
    await poller.tick()
    expect(calls).toHaveLength(2)
  })

  it('refreshes on demand when no guard is given', async () => {
    const { calls, got, poller } = setup()
    const r = poller.refresh()
    expect(calls).toHaveLength(1)
    calls[0]?.resolve(3)
    await r
    expect(got).toEqual([3])
  })

  it('reports errors from the current run, wrapping non-errors', async () => {
    const { calls, errors, poller } = setup()
    const a = poller.run()
    calls[0]?.reject('plain')
    await a
    expect(errors[0]?.message).toBe('plain')
    const b = poller.run()
    calls[1]?.reject(new Error('x'))
    await b
    expect(errors[1]?.message).toBe('x')
  })
})

describe('createPoller failures (Chronometer spec 4.4)', () => {
  function counting() {
    const calls: ReturnType<typeof deferred<number>>[] = []
    const counts: number[] = []
    const poller = createPoller<number>(
      () => {
        const d = deferred<number>()
        calls.push(d)
        return d.promise
      },
      { data: () => {}, error: () => {}, failures: (n) => counts.push(n) },
    )
    return { calls, counts, poller }
  }

  it('counts consecutive failed runs and goes back to 0 after a success', async () => {
    const { calls, counts, poller } = counting()
    for (let i = 0; i < 3; i++) {
      const r = poller.run()
      calls[i]?.reject(new Error('down'))
      await r
    }
    const ok = poller.run()
    calls[3]?.resolve(1)
    await ok
    expect(counts).toEqual([1, 2, 3, 0])
  })

  it('does not count a dropped run, and restarts the count on reset', async () => {
    const { calls, counts, poller } = counting()
    const first = poller.run()
    calls[0]?.reject(new Error('down'))
    await first
    const late = poller.run()
    poller.reset()
    calls[1]?.reject(new Error('late'))
    await late
    const next = poller.run()
    calls[2]?.reject(new Error('down'))
    await next
    expect(counts).toEqual([1, 1])
  })
})
