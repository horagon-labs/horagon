import { describe, expect, it } from 'vitest'
import { singleFlight } from '../lib/single-flight'

function deferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('singleFlight (fix M2)', () => {
  it('never starts a second run while one is in flight', async () => {
    const flight = singleFlight()
    const gate = deferred()
    let calls = 0
    const task = async () => {
      calls++
      await gate.promise
    }
    const first = flight.run(task)
    expect(flight.running()).toBe(true)
    await expect(flight.run(task)).resolves.toBe(false)
    expect(calls).toBe(1)
    gate.resolve()
    await expect(first).resolves.toBe(true)
    expect(flight.running()).toBe(false)
  })

  it('frees itself after a failure, which the caller still sees', async () => {
    const flight = singleFlight()
    await expect(
      flight.run(async () => {
        throw new Error('claim failed')
      }),
    ).rejects.toThrow('claim failed')
    expect(flight.running()).toBe(false)
    let ran = false
    await expect(
      flight.run(async () => {
        ran = true
      }),
    ).resolves.toBe(true)
    expect(ran).toBe(true)
  })
})
