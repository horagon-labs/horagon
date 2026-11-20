import { describe, expect, expectTypeOf, it } from 'vitest'
import { HoragonError } from '../../src/errors'
import type { ResolutionEvidence } from '../../src/evidence/types'
import { outcomeFor, parseResolutionEvidence } from '../../src/evidence/validate'

const FINAL: ResolutionEvidence = {
  v: 1,
  league: 'NBA',
  gameId: '401910007',
  kind: 0,
  home: 'CLE',
  away: 'MEM',
  homeScore: 112,
  awayScore: 108,
  periods: [
    [37, 30],
    [35, 41],
    [20, 19],
    [20, 18],
  ],
  status: 'final',
  rule: 'winner-incl-ot',
  outcome: 'yes',
  sources: [
    {
      name: 'espn',
      url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261118',
      fetchedAt: '2026-11-19T02:41:07Z',
    },
    {
      name: 'guardian',
      url: 'https://www.nba.com/game/mem-vs-cle-0022600231/box-score',
      fetchedAt: '2026-11-19T02:52:30Z',
    },
  ],
}

function rejects(value: unknown, message: RegExp): void {
  try {
    parseResolutionEvidence(value)
  } catch (e) {
    expect(e).toBeInstanceOf(HoragonError)
    expect((e as HoragonError).code).toBe('INVALID_INPUT')
    expect((e as HoragonError).message).toMatch(message)
    return
  }
  throw new Error('expected parseResolutionEvidence to throw')
}

describe('parseResolutionEvidence', () => {
  it('accepts a consistent final game and returns the same object shape', () => {
    const parsed = parseResolutionEvidence(FINAL)
    expect(parsed).toEqual(FINAL)
    expectTypeOf(parsed).toEqualTypeOf<ResolutionEvidence>()
  })

  it('accepts an overtime game whose fifth period decides it', () => {
    const ot = {
      ...FINAL,
      homeScore: 120,
      awayScore: 118,
      periods: [...FINAL.periods.slice(0, 3), [20, 22], [10, 4]],
    }
    ot.awayScore = ot.periods.reduce((s, p) => s + (p[1] ?? 0), 0)
    ot.homeScore = ot.periods.reduce((s, p) => s + (p[0] ?? 0), 0)
    expect(parseResolutionEvidence(ot).outcome).toBe('yes')
  })

  it.each([
    [{ ...FINAL, homeScore: 113 }, /periods add up to 112-108/],
    [{ ...FINAL, outcome: 'no' }, /outcome must be yes/],
    [{ ...FINAL, rule: 'second-half-q3-q4' }, /kind 0 uses rule winner-incl-ot/],
    [{ ...FINAL, homeScore: 112.5 }, /homeScore/],
    [{ ...FINAL, extra: 1 }, /Unrecognized key/],
    [{ ...FINAL, away: 'CLE' }, /same team/],
    [{ ...FINAL, periods: FINAL.periods.slice(0, 3) }, /at least 4 periods/],
    [
      { ...FINAL, sources: [{ ...FINAL.sources[0], url: 'http://example.com' }] },
      /sources\.0\.url/,
    ],
    [{ ...FINAL, sources: [{ ...FINAL.sources[0], fetchedAt: '2026-11-19 02:41' }] }, /fetchedAt/],
    [null, /\$/],
  ])('rejects %#', (value, message) => {
    rejects(value, message)
  })

  it('applies the second-half rule: Q3 + Q4 only, a tie is NO', () => {
    const half = { ...FINAL, kind: 1 as const, rule: 'second-half-q3-q4' }
    // Q3 + Q4: home 40, away 37 -> YES.
    expect(parseResolutionEvidence({ ...half, outcome: 'yes' }).outcome).toBe('yes')
    const tied = {
      ...half,
      periods: [
        [37, 30],
        [35, 41],
        [20, 21],
        [20, 19],
      ],
      homeScore: 112,
      awayScore: 111,
      outcome: 'no',
    }
    expect(parseResolutionEvidence(tied).outcome).toBe('no')
  })

  it('resolves a postponed game NO under its own rule', () => {
    const postponed = {
      ...FINAL,
      status: 'postponed',
      rule: 'postponed-over-7-days',
      homeScore: 0,
      awayScore: 0,
      periods: [],
      outcome: 'no',
    }
    expect(parseResolutionEvidence(postponed).status).toBe('postponed')
    rejects({ ...postponed, outcome: 'yes' }, /postponed game resolves NO/)
  })
})

describe('outcomeFor', () => {
  it('ignores overtime for the second half', () => {
    const periods = [
      [20, 20],
      [20, 20],
      [25, 20],
      [20, 25],
      [10, 2],
    ] as const
    expect(outcomeFor(1, 95, 87, periods)).toBe('no')
    expect(outcomeFor(0, 95, 87, periods)).toBe('yes')
  })

  it('needs Q3 and Q4 for the second half', () => {
    expect(() => outcomeFor(1, 40, 40, [[20, 20]])).toThrow(/Q3 and Q4/)
  })
})
