import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clockToSecs, ReplayGameSchema } from '../src/replay'

const RECORDED = join(import.meta.dirname, '../../../tests/fixtures/replay')

const game = (patch: Record<string, unknown> = {}) => ({
  schema: 'horagon.replay.v0',
  gameDate: '2026-11-18',
  home: 'CLE',
  away: 'MEM',
  tipoffUtc: '2026-11-19T00:00Z',
  frames: [
    {
      t: '2026-11-18T23:30:03.394Z',
      source: 'espn',
      status: 'pre',
      period: 0,
      clock: '0.0',
      homeScore: 0,
      awayScore: 0,
    },
  ],
  ...patch,
})

describe('ReplayGameSchema', () => {
  it('parses every recorded fixture', () => {
    const files = readdirSync(RECORDED).filter((n) => n.endsWith('.json'))
    expect(files).toHaveLength(12)
    for (const name of files) {
      const parsed = ReplayGameSchema.parse(JSON.parse(readFileSync(join(RECORDED, name), 'utf8')))
      expect(name).toBe(`${parsed.gameDate}-${parsed.away}-at-${parsed.home}.json`)
    }
  })

  it('normalises a tip-off without seconds and keeps frame times exact', () => {
    const parsed = ReplayGameSchema.parse(game())
    expect(parsed.tipoffUtc).toBe('2026-11-19T00:00:00.000Z')
    expect(parsed.frames[0]?.t).toBe('2026-11-18T23:30:03.394Z')
  })

  it.each([
    { tipoffUtc: '2026-11-19 00:00' },
    { tipoffUtc: '2026-11-18T19:00-05:00' },
    { schema: 'horagon.replay.v9' },
    { home: 'cle' },
    { frames: [] },
  ])('refuses %o', (patch) => {
    expect(ReplayGameSchema.safeParse(game(patch)).success).toBe(false)
  })
})

describe('clockToSecs', () => {
  it.each([
    ['11:16', 676],
    ['1:00', 60],
    ['59.9', 60],
    ['45.3', 45],
    ['0.0', 0],
    ['12:00', 720],
    ['PT05M30.00S', 330],
    ['PT00M00.00S', 0],
    ['garbage', 0],
    ['-3', 0],
  ])('%s is %d s', (clock, secs) => {
    expect(clockToSecs(clock)).toBe(secs)
  })
})
