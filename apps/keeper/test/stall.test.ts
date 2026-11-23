import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger, timeoutFetch } from '../src/config'
import { runStep } from '../src/loop'
import { STALL_CHECK_MS, StallGuard, watchStall } from '../src/stall'

describe('StallGuard and watchStall', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = (stallSecs = 120) => {
    let clock = 0
    const guard = new StallGuard(stallSecs, () => clock)
    const fatal = vi.fn()
    const flush = vi.fn()
    const exit = vi.fn()
    const timer = watchStall(guard, { fatal, flush } as never, exit)
    const advance = (ms: number) => {
      clock += ms
      vi.advanceTimersByTime(ms)
    }
    return { guard, fatal, flush, exit, timer, advance }
  }

  it('does not exit while activity keeps coming', () => {
    const { guard, exit, advance } = setup()
    for (let i = 0; i < 40; i++) {
      advance(STALL_CHECK_MS)
      guard.touch()
    }
    expect(exit).not.toHaveBeenCalled()
  })

  it('exits after the stall limit of silence, reporting the step in progress', () => {
    const { guard, fatal, flush, exit, advance } = setup()
    guard.step('index')
    for (let i = 0; i < 7; i++) advance(STALL_CHECK_MS)
    expect(exit).not.toHaveBeenCalled()
    advance(STALL_CHECK_MS)
    expect(fatal).toHaveBeenCalledWith(
      { stalledSecs: 120, step: 'index' },
      'keeper stalled: exiting so the service restarts',
    )
    expect(flush).toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('reports step null between steps', () => {
    const { guard, fatal, advance } = setup(30)
    guard.step('tick')
    guard.step(null)
    advance(30_000)
    expect(fatal).toHaveBeenCalledWith({ stalledSecs: 30, step: null }, expect.any(String))
  })

  it('unrefs its timer', () => {
    const { timer } = setup()
    expect(timer.hasRef()).toBe(false)
  })

  it('counts a step starting or finishing as activity', async () => {
    const { guard, exit, advance } = setup(30)
    advance(15_000)
    await runStep(pino({ level: 'silent' }), 'tick', async () => 1, guard)
    advance(15_000)
    expect(exit).not.toHaveBeenCalled()
  })
})

describe('activity sources', () => {
  it('a log line counts as activity, and the output is unchanged', () => {
    const lines: string[] = []
    const touch = vi.fn()
    const dest = { write: (l: string) => void lines.push(l) }
    const hooked = createLogger('info', 'keeper', dest, touch)
    hooked.info({ a: 1 }, 'hello')
    hooked.debug('hidden')
    expect(touch).toHaveBeenCalledTimes(1)
    const plain: string[] = []
    createLogger('info', 'keeper', { write: (l: string) => void plain.push(l) }).info(
      { a: 1 },
      'hello',
    )
    const strip = (l: string | undefined) => JSON.parse(l ?? '{}') as Record<string, unknown>
    expect({ ...strip(lines[0]), time: 0 }).toEqual({ ...strip(plain[0]), time: 0 })
  })

  it('a completed fetch counts as activity, answered, failed or aborted', async () => {
    const touch = vi.fn()
    const ok = (async () => new Response('{}')) as unknown as typeof fetch
    await timeoutFetch(1000, ok, touch)('https://x.example')
    expect(touch).toHaveBeenCalledTimes(1)
    const bad = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    await expect(timeoutFetch(1000, bad, touch)('https://x.example')).rejects.toThrow('network')
    expect(touch).toHaveBeenCalledTimes(2)
    const hang = ((_u: string, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(init.signal?.reason))
      })) as unknown as typeof fetch
    await expect(timeoutFetch(20, hang, touch)('https://x.example')).rejects.toMatchObject({
      name: 'TimeoutError',
    })
    expect(touch).toHaveBeenCalledTimes(3)
  })
})
