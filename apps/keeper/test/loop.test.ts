import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { dueEvery, FailureStreak, runStep } from '../src/loop'

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
