// The end_ts measurements: game state at a time, the close statistics and their edge cases.
import { describe, expect, it } from 'vitest'
import {
  clockSecs,
  endPlay,
  type GameTimeline,
  gameStats,
  offsetStats,
  type Play,
  q4Mark,
  quantile,
  startsBeforeSchedule,
  stateAt,
} from '../src/lib/end-ts'

const S = Date.parse('2026-11-19T00:00Z')
const at = (min: number) => S + min * 60_000

/** Tip at S + 10, Q4 at S + 115, 5:20 left at S + 125, 1:00 left (+2) at S + 140, end at S + 150. */
const plays: Play[] = [
  [at(10), 1, 720, 0, 0, 0],
  [at(40), 2, 720, 30, 28, 0],
  [at(80), 3, 720, 55, 52, 0],
  [at(115), 4, 720, 85, 80, 0],
  [at(125), 4, 320, 95, 90, 0],
  [at(140), 4, 60, 110, 108, 0],
  [at(150), 4, 0, 112, 110, 1],
]
const game = (over: Partial<GameTimeline> = {}): GameTimeline => ({
  id: '401910007',
  date: '20261118',
  scheduled: '2026-11-19T00:00Z',
  name: 'MEM @ CLE',
  periods: 4,
  plays,
  ...over,
})

describe('clockSecs', () => {
  it('reads M:SS and the tenths ESPN shows under a minute', () => {
    expect(clockSecs('11:54')).toBe(714)
    expect(clockSecs('0.0')).toBe(0)
    expect(clockSecs('45.3')).toBe(45.3)
    expect(clockSecs(undefined)).toBe(0)
  })
})

describe('game state', () => {
  it('finds the latest play at a time, and nothing before the tip', () => {
    expect(stateAt(game(), at(5))).toBeNull()
    expect(stateAt(game(), at(130))?.[2]).toBe(320)
    expect(stateAt(game(), at(400))?.[5]).toBe(1)
  })

  it('reads past a play whose wallclock is stamped late', () => {
    const late: Play = [at(160), 1, 0, 25, 24, 0]
    const g = game({ plays: [plays[0] as Play, late, ...plays.slice(1)] })
    expect(stateAt(g, at(130))).toEqual(plays[4])
    expect(offsetStats([g], 130).closeInQ4OrLaterPct).toBe(100)
  })

  it('takes the End Game play, else the last play', () => {
    expect(endPlay(game())[0]).toBe(at(150))
    const noEnd = plays.map((p): Play => [p[0], p[1], p[2], p[3], p[4], 0])
    expect(endPlay(game({ plays: noEnd.slice(0, 6) }))[0]).toBe(at(140))
    expect(() => endPlay(game({ plays: [] }))).toThrow('no plays')
  })

  it('reports tip, Q4 start, end and margin from S', () => {
    expect(gameStats(game())).toEqual({
      id: '401910007',
      date: '20261118',
      name: 'MEM @ CLE',
      overtime: false,
      tipMin: 10,
      endMin: 150,
      q4StartMin: 115,
      finalMargin: 2,
    })
    expect(gameStats(game({ periods: 5 })).overtime).toBe(true)
    expect(gameStats(game({ plays: plays.slice(0, 3) })).q4StartMin).toBeNull()
  })

  it('flags a timeline that starts before the scheduled tip-off', () => {
    expect(startsBeforeSchedule(game())).toBe(false)
    expect(startsBeforeSchedule(game({ scheduled: '2026-11-19T01:00Z' }))).toBe(true)
  })

  it('finds the first play with 2:00 or less left in Q4', () => {
    expect(q4Mark(game(), 120)).toEqual([140, 2])
    expect(q4Mark(game({ plays: plays.slice(0, 3) }), 120)).toBeNull()
  })
})

describe('offsetStats', () => {
  it('measures a close in Q4 before the end', () => {
    expect(offsetStats([game()], 130)).toEqual({
      offsetMin: 130,
      endedBeforeClose: 0,
      closeInQ4OrLaterPct: 100,
      q4GameMinTradableMedian: 400 / 60,
      gameTradableMedianPct: 100 * (1 - 320 / 2880),
      clutchOpen: 0,
      q4WallMinBeforeCloseMedian: 15,
      pairedEndBeforeClosePct: 0,
    })
  })

  it('counts a close game still open in its last minute', () => {
    expect(offsetStats([game()], 145).clutchOpen).toBe(1)
  })

  it('counts a game that ended before the close as all of Q4 tradable', () => {
    const s = offsetStats([game()], 150)
    expect(s.endedBeforeClose).toBe(1)
    expect(s.q4GameMinTradableMedian).toBe(12)
    expect(s.q4WallMinBeforeCloseMedian).toBe(35)
    expect(s.pairedEndBeforeClosePct).toBe(100)
  })

  it('counts a close before Q4 as none of Q4 tradable', () => {
    const s = offsetStats([game()], 100)
    expect(s.closeInQ4OrLaterPct).toBe(0)
    expect(s.q4GameMinTradableMedian).toBe(0)
    expect(s.q4WallMinBeforeCloseMedian).toBe(0)
  })

  it('counts a close before the tip as nothing tradable', () => {
    expect(offsetStats([game()], 5).gameTradableMedianPct).toBe(0)
  })
})

describe('quantile', () => {
  it('interpolates between ranks', () => {
    expect(quantile([3, 1, 2], 0.5)).toBe(2)
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(quantile([], 0.5)).toBeNaN()
  })
})
