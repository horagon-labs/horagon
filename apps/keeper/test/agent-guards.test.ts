import { describe, expect, it } from 'vitest'
import {
  ANOMALY_HOLD_SECS,
  AnomalyWatch,
  FailureGuard,
  Rotation,
  SpendBook,
} from '../src/agent/guards'

describe('AnomalyWatch', () => {
  const yes = { gameId: 'nba-1', side: 'yes' as const, model: 0.7, price: 0.6, at: 1_000 }
  const no = { gameId: 'nba-2', side: 'no' as const, model: 0.4, price: 0.5, at: 1_010 }
  const none = { state: 'none' }
  /** The read 20 s after the swap. */
  const T = 1_020
  const END = T + ANOMALY_HOLD_SECS

  it('holds a market whose gap grew on the same side, then disables it at the end of the hold, once', () => {
    const w = new AnomalyWatch()
    w.expect('A', yes)
    expect(w.check('A', 0.58, T)).toEqual({ state: 'held', sent: yes, until: END, first: true })
    expect(w.held('A')).toBe(true)
    expect(w.disabled('A')).toBe(false)
    // Still grown before the end: held, not disabled.
    expect(w.check('A', 0.57, END - 1)).toEqual({
      state: 'held',
      sent: yes,
      until: END,
      first: false,
    })
    expect(w.disabled('A')).toBe(false)
    expect(w.check('A', 0.58, END)).toEqual({ state: 'disabled', sent: yes })
    expect(w.disabled('A')).toBe(true)
    expect(w.held('A')).toBe(false)
    expect(w.check('A', 0.5, END + 20)).toEqual(none)
    w.expect('B', no)
    expect(w.check('B', 0.52, T)).toMatchObject({ state: 'held', sent: no })
    expect(w.check('B', 0.52, END)).toEqual({ state: 'disabled', sent: no })
    expect(w.disabledMarkets).toEqual(['A', 'B'])
  })

  it('leaves a market alone when the gap shrank, held or crossed', () => {
    const w = new AnomalyWatch()
    for (const price of [0.68, 0.6, 0.72]) {
      w.expect('A', yes)
      expect(w.check('A', price, T), String(price)).toEqual(none)
    }
    w.expect('B', no)
    expect(w.check('B', 0.42, T)).toEqual(none)
    expect(w.disabled('A') || w.disabled('B')).toBe(false)
  })

  it('clears a held market whose next read shows the gap no larger, or no price', () => {
    const w = new AnomalyWatch()
    w.expect('A', yes)
    expect(w.check('A', 0.58, T).state).toBe('held')
    expect(w.check('A', 0.65, END)).toEqual(none)
    expect(w.hasPending('A') || w.held('A') || w.disabled('A')).toBe(false)
    w.expect('B', no)
    expect(w.check('B', 0.52, T).state).toBe('held')
    expect(w.check('B', null, END)).toEqual(none)
    expect(w.hasPending('B') || w.disabled('B')).toBe(false)
  })

  it('checks only the next read: a null price clears it, and so does a market not read', () => {
    const w = new AnomalyWatch()
    w.expect('A', yes)
    expect(w.check('A', null, T)).toEqual(none)
    expect(w.hasPending('A')).toBe(false)
    expect(w.check('A', 0.5, T)).toEqual(none)
    w.expect('A', yes)
    w.expect('B', no)
    w.forgetExcept(new Set(['B']))
    expect(w.hasPending('A')).toBe(false)
    expect(w.hasPending('B')).toBe(true)
    expect(w.check('C', 0.1, T)).toEqual(none)
  })

  it('clears a check when another wallet traded at or after the swap, without disabling', () => {
    const w = new AnomalyWatch()
    w.expect('A', yes)
    // A trade before the swap's read explains nothing: the check stays.
    expect(w.clearAfter('A', 999)).toBe(false)
    expect(w.hasPending('A')).toBe(true)
    // At the swap's time, or after it: cleared, and the wrong-way read that follows is no
    // anomaly.
    expect(w.clearAfter('A', 1_000)).toBe(true)
    expect(w.check('A', 0.5, T)).toEqual(none)
    expect(w.disabled('A')).toBe(false)
    w.expect('B', no)
    expect(w.clearAfter('B', 1_050)).toBe(true)
    expect(w.hasPending('B')).toBe(false)
    // Nothing pending: nothing to clear.
    expect(w.clearAfter('C', 2_000)).toBe(false)
    expect(w.disabledMarkets).toEqual([])
  })

  it('clears a held market once a trade after the swap is stored', () => {
    const w = new AnomalyWatch()
    w.expect('A', yes)
    expect(w.check('A', 0.58, T).state).toBe('held')
    // The trade landed before the read (at 1_015) and was stored after it.
    expect(w.clearAfter('A', 1_015)).toBe(true)
    expect(w.held('A')).toBe(false)
    expect(w.check('A', 0.58, END)).toEqual(none)
    expect(w.disabled('A')).toBe(false)
  })

  it('knows the oldest swap still checked, held ones included', () => {
    const w = new AnomalyWatch()
    expect(w.oldestPendingAt).toBeNull()
    w.expect('B', no)
    w.expect('A', yes)
    expect(w.oldestPendingAt).toBe(1_000)
    w.check('A', 0.58, T)
    expect(w.oldestPendingAt).toBe(1_000)
    w.check('A', 0.65, T + 20)
    expect(w.oldestPendingAt).toBe(1_010)
    w.clearAfter('B', 1_010)
    expect(w.oldestPendingAt).toBeNull()
  })
})

describe('FailureGuard', () => {
  it('pauses at the 5th failure in a row, for pauseSecs, then starts over', () => {
    const g = new FailureGuard(5, 600)
    for (let i = 0; i < 4; i++) expect(g.fail(1_000)).toBe(false)
    expect(g.fail(1_000)).toBe(true)
    expect(g.pausedUntil).toBe(1_600)
    expect(g.paused(1_599)).toBe(true)
    expect(g.paused(1_600)).toBe(false)
    expect(g.count).toBe(0)
  })

  it('ends the streak on a clean round', () => {
    const g = new FailureGuard(5, 600)
    for (let i = 0; i < 4; i++) g.fail(0)
    g.clean()
    for (let i = 0; i < 4; i++) expect(g.fail(0)).toBe(false)
    expect(g.paused(0)).toBe(false)
  })
})

describe('SpendBook', () => {
  it('takes the larger of its own count and the DB, for spend and swaps apart', () => {
    const b = new SpendBook()
    expect(b.totals('A')).toEqual({ spent: 0n, swaps: 0 })
    b.record('A', 30n)
    b.record('A', 20n)
    expect(b.totals('A')).toEqual({ spent: 50n, swaps: 2 })
    expect(b.totals('A', { spent: 10n, swaps: 5 })).toEqual({ spent: 50n, swaps: 5 })
    expect(b.totals('A', { spent: 90n, swaps: 1 })).toEqual({ spent: 90n, swaps: 2 })
  })
})

describe('Rotation', () => {
  it('starts at the first market until one is decided, then at the one after it, wrapping', () => {
    const r = new Rotation()
    expect(r.start(['A', 'B', 'C'])).toBe(0)
    r.decided('A', ['A', 'B', 'C'])
    expect(r.start(['A', 'B', 'C'])).toBe(1)
    r.decided('C', ['A', 'B', 'C'])
    expect(r.start(['A', 'B', 'C'])).toBe(0)
    expect(r.start([])).toBe(0)
  })

  it('starts at a market listed since, when it comes right after the last one decided', () => {
    const r = new Rotation()
    r.decided('B', ['A', 'B', 'C'])
    expect(r.start(['A', 'B', 'X', 'C'])).toBe(2)
  })

  it('starts at the next market still listed when the last one decided is gone', () => {
    const r = new Rotation()
    r.decided('B', ['A', 'B', 'C', 'D'])
    // B's game ended: C comes next.
    expect(r.start(['A', 'C', 'D'])).toBe(1)
    // B and C gone: D; B, C and D gone: A, wrapping around.
    expect(r.start(['A', 'D'])).toBe(1)
    expect(r.start(['X', 'A'])).toBe(1)
    // None of the markets listed then is listed now.
    expect(r.start(['X', 'Y'])).toBe(0)
  })
})
