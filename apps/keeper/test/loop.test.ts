import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dueEvery,
  FailureStreak,
  indexSteps,
  PeriodicLoop,
  roundSteps,
  runRound,
  runStep,
} from '../src/loop'

describe('FailureStreak', () => {
  it('alerts from the 12th failure in a row, with the error summary', () => {
    const tick = new FailureStreak('tick')
    for (let i = 1; i <= 11; i++) {
      expect(tick.record({ ok: false, error: new Error(`boom ${i}`) }), `failure ${i}`).toBeNull()
    }
    const alert = tick.record({
      ok: false,
      error: new Error('getMultipleAccounts https://rpc.example/?api-key=SECRET 503'),
    })
    expect(alert?.key).toBe('tick-failing')
    expect(alert?.text).toContain('12 rounds in a row')
    expect(alert?.text).toContain('https://rpc.example/…')
    expect(alert?.text).not.toContain('SECRET')
    // Still failing: every further round asks again (the alerter's 3 h window drops repeats,
    // and a failed delivery is retried a minute later).
    expect(tick.record({ ok: false, error: new Error('boom') })?.key).toBe('tick-failing')
    expect(tick.count).toBe(13)
  })

  it('resets on the next success, and counts each step apart', () => {
    const tick = new FailureStreak('tick')
    const index = new FailureStreak('index')
    for (let i = 0; i < 11; i++) {
      tick.record({ ok: false, error: 'x' })
      index.record({ ok: false, error: 'y' })
    }
    expect(tick.record({ ok: true })).toBeNull()
    expect(tick.count).toBe(0)
    expect(tick.record({ ok: false, error: 'x' })).toBeNull()
    expect(index.record({ ok: false, error: 'y' })?.key).toBe('index-failing')
  })

  it('takes another threshold', () => {
    const s = new FailureStreak('index', 2)
    expect(s.record({ ok: false, error: 'a' })).toBeNull()
    expect(s.record({ ok: false, error: 'a' })?.key).toBe('index-failing')
  })
})

describe('dueEvery', () => {
  it('is due at once, then once per period of the clock it is given', () => {
    const hourly = dueEvery(3_600)
    expect(hourly(1_000_000)).toBe(true)
    expect(hourly(1_000_005)).toBe(false)
    expect(hourly(1_003_599)).toBe(false)
    expect(hourly(1_003_600)).toBe(true)
    expect(hourly(1_003_605)).toBe(false)
  })
})

describe('runStep', () => {
  it('returns the value, or logs the redacted error and returns it', async () => {
    const lines: Array<Record<string, unknown>> = []
    const log = pino({ level: 'info' }, { write: (l: string) => void lines.push(JSON.parse(l)) })
    expect(await runStep(log, 'tick', async () => [1, 2])).toEqual({ ok: true, value: [1, 2] })
    const failed = await runStep(log, 'index', async () => {
      throw new Error('https://rpc.example/?api-key=SECRET timed out')
    })
    expect(failed.ok).toBe(false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ level: 50, step: 'index', msg: 'step failed' })
    expect(JSON.stringify(lines)).not.toContain('SECRET')
  })
})

describe('roundSteps', () => {
  it('runs the tick first, then the hourly group behind one gate; the index work has its own loop', () => {
    expect(roundSteps({ hourly: false, archive: true })).toEqual(['tick'])
    expect(roundSteps({ hourly: true, archive: true })).toEqual([
      'tick',
      'schedule',
      'treasury',
      'archive',
    ])
    expect(roundSteps({ hourly: true, archive: false })).toEqual(['tick', 'schedule', 'treasury'])
  })
})

describe('indexSteps', () => {
  it('runs the indexer, then the ATA watch when it is due', () => {
    expect(indexSteps({ ataWatch: false })).toEqual(['index'])
    expect(indexSteps({ ataWatch: true })).toEqual(['index', 'ata-watch'])
  })
})

describe('runRound', () => {
  it('runs every step in order when not stopping', async () => {
    const ran: string[] = []
    const steps = roundSteps({ hourly: true, archive: true })
    const done = await runRound(
      steps,
      async (s) => void ran.push(s),
      () => false,
    )
    expect(ran).toEqual(['tick', 'schedule', 'treasury', 'archive'])
    expect(done).toEqual({ ran, stopped: false })
  })

  it('ends the round after the step in progress once stopping', async () => {
    let stopping = false
    const ran: string[] = []
    const r = await runRound(
      indexSteps({ ataWatch: true }),
      async (s) => {
        ran.push(s)
        // SIGTERM arrives while the indexer runs: it finishes, nothing after it starts.
        if (s === 'index') stopping = true
      },
      () => stopping,
    )
    expect(ran).toEqual(['index'])
    expect(r).toEqual({ ran: ['index'], stopped: true })

    const none = await runRound(
      ['tick', 'index'],
      async () => {},
      () => true,
    )
    expect(none).toEqual({ ran: [], stopped: true })
  })
})

describe('PeriodicLoop', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  it('runs a round every period, never two at once, until stopping', async () => {
    vi.useFakeTimers()
    let stopping = false
    let running = 0
    let most = 0
    const starts: number[] = []
    const loop = new PeriodicLoop({
      periodMs: 10,
      stopping: () => stopping,
      round: async () => {
        running++
        most = Math.max(most, running)
        starts.push(Date.now())
        // Every other round takes longer than the period.
        await sleep(starts.length % 2 === 0 ? 25 : 1)
        running--
      },
    })
    const done = loop.run()
    await vi.advanceTimersByTimeAsync(150)
    stopping = true
    loop.wake()
    await vi.advanceTimersByTimeAsync(50)
    await done
    expect(most).toBe(1)
    // Start to start: 10 ms after a short round, at once (the next timer tick) after a long one.
    const gaps = starts.slice(1).map((t, i) => t - (starts[i] ?? 0))
    expect(gaps[0]).toBe(10)
    expect(gaps[1]).toBeGreaterThanOrEqual(25)
    expect(gaps[1]).toBeLessThanOrEqual(26)
    expect(gaps[2]).toBe(10)
    expect(loop.rounds).toBe(starts.length)
    expect(loop.busyMs()).toBeNull()
  })

  it('ends after the round in progress once stopping, and a wake cuts the wait short', async () => {
    vi.useFakeTimers()
    let stopping = false
    let release: () => void = () => {}
    const loop = new PeriodicLoop({
      periodMs: 60_000,
      stopping: () => stopping,
      round: () => new Promise<void>((r) => (release = r)),
    })
    const done = loop.run()
    await vi.advanceTimersByTimeAsync(20)
    expect(loop.busyMs()).toBe(20)
    stopping = true
    let ended = false
    void done.then(() => (ended = true))
    await vi.advanceTimersByTimeAsync(20)
    // The round in progress is not cut off.
    expect(ended).toBe(false)
    release()
    await done
    expect(loop.rounds).toBe(1)

    // A loop asleep between rounds stops at once on a wake.
    stopping = false
    const idle = new PeriodicLoop({
      periodMs: 60_000,
      stopping: () => stopping,
      round: async () => {},
    })
    const idleDone = idle.run()
    await vi.advanceTimersByTimeAsync(20)
    stopping = true
    idle.wake()
    await idleDone
    expect(idle.rounds).toBe(1)
  })

  it('counts a stall from the last progress of the round in progress, not from its start', async () => {
    vi.useFakeTimers()
    let stopping = false
    let release: () => void = () => {}
    const loop = new PeriodicLoop({
      periodMs: 60_000,
      stopping: () => stopping,
      round: () => new Promise<void>((r) => (release = r)),
    })
    // Progress before any round does not count for the next one.
    loop.progress()
    await vi.advanceTimersByTimeAsync(5)
    expect(loop.stalledMs()).toBeNull()
    const done = loop.run()
    await vi.advanceTimersByTimeAsync(100)
    expect(loop.stalledMs()).toBe(100)
    loop.progress()
    await vi.advanceTimersByTimeAsync(30)
    expect(loop.stalledMs()).toBe(30)
    expect(loop.busyMs()).toBe(130)
    stopping = true
    release()
    await done
    expect(loop.stalledMs()).toBeNull()
  })
})
