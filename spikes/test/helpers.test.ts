// The few pure helpers whose output ends up in results and replay fixtures.
import { describe, expect, it } from 'vitest'
import { maxInvokeDepth } from '../src/lib/chain'
import { espnStatus, nbaTricode, POLYMARKET_GAME_SLUG } from '../src/lib/feeds'

describe('espnStatus', () => {
  it('maps the three ESPN states', () => {
    expect(espnStatus({ state: 'pre', completed: false })).toBe('pre')
    expect(espnStatus({ state: 'in', completed: false })).toBe('live')
    expect(espnStatus({ state: 'post', completed: true })).toBe('final')
  })

  it('never reads a postponed game as final', () => {
    expect(espnStatus({ state: 'post', completed: false })).toBe('postponed')
  })
})

describe('nbaTricode', () => {
  it('maps the ESPN abbreviations that differ and keeps the rest', () => {
    expect(['GS', 'NY', 'NO', 'SA', 'UTAH', 'WSH'].map(nbaTricode)).toEqual([
      'GSW',
      'NYK',
      'NOP',
      'SAS',
      'UTA',
      'WAS',
    ])
    expect(nbaTricode('BOS')).toBe('BOS')
  })
})

describe('POLYMARKET_GAME_SLUG', () => {
  it('matches single games only', () => {
    expect(POLYMARKET_GAME_SLUG.test('nba-bos-gsw-2026-11-22')).toBe(true)
    expect(POLYMARKET_GAME_SLUG.test('nba-champion-2027')).toBe(false)
    expect(POLYMARKET_GAME_SLUG.test('nba-bos-gsw-2026-11-22-total-220pt5')).toBe(false)
  })
})

describe('maxInvokeDepth', () => {
  it('reads the deepest CPI from the logs', () => {
    const logs = [
      'Program Hrg111 invoke [1]',
      'Program GV1FMG invoke [2]',
      'Program metaqbxx invoke [3]',
      'Program metaqbxx success',
      'Program GV1FMG success',
      'Program log: invoke [9] is not a frame',
      'Program Hrg111 success',
    ]
    expect(maxInvokeDepth(logs)).toBe(3)
    expect(maxInvokeDepth([])).toBe(0)
  })
})
