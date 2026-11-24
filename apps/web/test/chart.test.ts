import type { GameHistory } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import { chartSeries } from '../lib/chart'
import { loadFollows, toggleFollow } from '../lib/follows'

const M = 'So11111111111111111111111111111111111111112'
const OTHER = 'Sysvar1111111111111111111111111111111111111'

const snap = (ts: number, h: number, a: number, modelProb: number | null) => ({
  ts,
  homeScore: h,
  awayScore: a,
  period: 1,
  clockSecs: 600,
  modelProb,
})

describe('chartSeries', () => {
  const history: GameHistory = {
    gameId: 'nba-1',
    snapshots: [snap(130, 8, 0, 0.7), snap(100, 0, 0, 0.5), snap(115, 4, 0, null)],
    prices: [
      { market: M, ts: 120, price: 0.6 },
      { market: M, ts: 100, price: 0.5 },
      { market: M, ts: 120, price: 0.62 },
      { market: OTHER, ts: 110, price: 0.1 },
    ],
  }

  it('keeps one ascending point per second for the chosen market', () => {
    expect(chartSeries(history, M).market).toEqual([
      { time: 100, value: 0.5 },
      { time: 120, value: 0.62 },
    ])
  })

  it('skips snapshots without a model probability', () => {
    expect(chartSeries(history, M).model.map((p) => p.time)).toEqual([100, 130])
  })
})

describe('follows', () => {
  const store = () => {
    const map = new Map<string, string>()
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    }
  }

  it('toggles a team on and off', () => {
    const s = store()
    expect(toggleFollow(s, 'BOS')).toEqual(['BOS'])
    expect(toggleFollow(s, 'NYK')).toEqual(['BOS', 'NYK'])
    expect(toggleFollow(s, 'BOS')).toEqual(['NYK'])
    expect(loadFollows(s)).toEqual(['NYK'])
  })

  it('survives corrupt or blocked storage', () => {
    const s = store()
    s.setItem('horagon.follows.v1', '{not json')
    expect(loadFollows(s)).toEqual([])
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(loadFollows(blocked)).toEqual([])
    expect(toggleFollow(blocked, 'BOS')).toEqual(['BOS'])
    expect(loadFollows(null)).toEqual([])
  })
})
