import { describe, expect, it } from 'vitest'
import { AnomalyWatch, FailureGuard, Rotation, SpendBook } from '../src/agent/guards'

describe('AnomalyWatch', () => {
  const yes = { gameId: 'nba-1', side: 'yes' as const, model: 0.7, price: 0.6 }
  const no = { gameId: 'nba-2', side: 'no' as const, model: 0.4, price: 0.5 }

  it('disables a market whose gap grew on the same side, once', () => {
    const w = new AnomalyWatch()
    w.expect('A', yes)
    expect(w.check('A', 0.58)).toEqual(yes)
    expect(w.disabled('A')).toBe(true)
    expect(w.check('A', 0.5)).toBeNull()
    w.expect('B', no)
    expect(w.check('B', 0.52)).toEqual(no)
    expect(w.disabledMarkets).toEqual(['A', 'B'])
  })

  it('leaves a market alone when the gap shrank, held or crossed', () => {
    const w = new AnomalyWatch()
    for (const price of [0.68, 0.6, 0.72]) {
      w.expect('A', yes)
      expect(w.check('A', price), String(price)).toBeNull()
    }
    w.expect('B', no)
    expect(w.check('B', 0.42)).toBeNull()
    expect(w.disabled('A') || w.disabled('B')).toBe(false)
  })

  it('checks only the next read: a null price clears it, and so does a market not read', () => {
    const w = new AnomalyWatch()
    w.expect('A', yes)
    expect(w.check('A', null)).toBeNull()
    expect(w.hasPending('A')).toBe(false)
    expect(w.check('A', 0.5)).toBeNull()
    w.expect('A', yes)
    w.expect('B', no)
    w.forgetExcept(new Set(['B']))
    expect(w.hasPending('A')).toBe(false)
    expect(w.hasPending('B')).toBe(true)
    expect(w.check('C', 0.1)).toBeNull()
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
