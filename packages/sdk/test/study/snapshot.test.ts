import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as study from '../../src/study'
import { type StudyRow, StudySnapshotSchema, studySnapshot } from '../../src/study'

const SDK = join(import.meta.dirname, '../..')
const ids = {
  horagon: 'Hor1111111111111111111111111111111111111111',
  pmAmm: 'Pm11111111111111111111111111111111111111111',
}
const row = (over: Partial<StudyRow>): StudyRow => ({
  market: 'Mkt1111111111111111111111111111111111111111',
  gameMarket: 'Gm11111111111111111111111111111111111111111',
  home: 'CHA',
  away: 'CHI',
  tipoff: '2026-11-26T00:00:00.000Z',
  initialPriceBps: 7_400,
  outcome: 'away',
  night: '2026-11-25',
  ...over,
})

describe('the study subpath (R10)', () => {
  it('is its own tsup entry and export, so a page that skips it ships none of it', () => {
    const pkg = JSON.parse(readFileSync(join(SDK, 'package.json'), 'utf8'))
    expect(pkg.exports['./study'].import.default).toBe('./dist/study.js')
    expect(pkg.exports['./study'].require.default).toBe('./dist/study.cjs')
    expect(readFileSync(join(SDK, 'tsup.config.ts'), 'utf8')).toContain(
      "study: 'src/study/index.ts'",
    )
  })

  it('imports no web3.js', () => {
    for (const f of ['index', 'calibration', 'upset', 'depth', 'lp-sim', 'snapshot']) {
      const src = readFileSync(join(SDK, 'src/study', `${f}.ts`), 'utf8')
      expect(src, f).not.toMatch(/@solana\/|from '\.\.\/(index|program|pm-amm|client)/)
    }
  })

  it('exports the pieces R8 reuses', () => {
    expect(typeof study.isUpset).toBe('function')
    expect(typeof study.calibration).toBe('function')
    expect(typeof study.depthCurve).toBe('function')
    expect(typeof study.lpLossSim).toBe('function')
  })
})

describe('studySnapshot (R10)', () => {
  const rows = [
    row({}),
    row({ night: '2026-11-27', initialPriceBps: 6_000, outcome: 'home', home: 'NYK', away: 'BOS' }),
    row({ night: '2026-11-27', initialPriceBps: 4_500, outcome: 'away', home: 'LAL', away: 'DEN' }),
  ]
  const snap = studySnapshot({
    generatedAt: '2026-11-28T08:00:00.000Z',
    slot: 123,
    programIds: ids,
    rows,
    missing: [],
    notPlayed: [],
    lpSim: { seed: 2026, paths: 40 },
  })

  it('validates against its own schema', () => {
    expect(StudySnapshotSchema.parse(snap)).toEqual(snap)
    expect(snap.schemaVersion).toBe(1)
  })

  it('scores every row, and each night apart, the counted ones marked', () => {
    expect(snap.calibration.n).toBe(3)
    expect(snap.calibration.upsets).toBe(1)
    expect(snap.nights.map((n) => [n.night, n.n, n.upsets, n.counted])).toEqual([
      ['2026-11-25', 1, 1, false],
      ['2026-11-27', 2, 0, true],
    ])
    expect(snap.firstCountedNight).toBe('2026-11-27')
  })

  it('carries the depth curves and the simulation with its seed', () => {
    expect(snap.depth.curves.map((c) => c.endOffsetSecs)).toEqual([10_800, 7_800])
    expect(snap.depth.medianFinalMinutes).toBe(151.6)
    expect(snap.lpSim).toMatchObject({ seed: 2026, paths: 40 })
  })

  it('makes the empty snapshot: no rows, no time, still a valid page', () => {
    const empty = studySnapshot({
      generatedAt: null,
      slot: null,
      programIds: ids,
      rows: [],
      missing: [],
      notPlayed: [],
      lpSim: { seed: 2026, paths: 40 },
    })
    expect(StudySnapshotSchema.parse(empty)).toMatchObject({
      generatedAt: null,
      rows: [],
      nights: [],
      calibration: { n: 0, brier: null },
    })
  })

  it('carries the not-played and missing markets unscored, sorted by tip-off', () => {
    const game = (n: number, tipoff: string) => {
      const {
        initialPriceBps: _p,
        outcome: _o,
        ...g
      } = row({
        market: `Mkt${n}111111111111111111111111111111111111111`.slice(0, 44),
        tipoff,
      })
      return g
    }
    const late = game(2, '2026-11-26T02:00:00.000Z')
    const early = game(3, '2026-11-26T00:30:00.000Z')
    const withOff = studySnapshot({
      generatedAt: null,
      slot: null,
      programIds: ids,
      rows,
      missing: [
        { ...late, reason: 'evidence' },
        { ...early, reason: 'account' },
      ],
      notPlayed: [late, early],
      lpSim: { seed: 2026, paths: 40 },
    })
    expect(StudySnapshotSchema.parse(withOff)).toEqual(withOff)
    expect(withOff.notPlayed.map((g) => g.tipoff)).toEqual([early.tipoff, late.tipoff])
    expect(withOff.missing.map((g) => g.reason)).toEqual(['account', 'evidence'])
    expect(withOff.calibration).toEqual(snap.calibration)
    expect(withOff.nights).toEqual(snap.nights)
    expect(() =>
      StudySnapshotSchema.parse({ ...withOff, missing: [{ ...early, reason: 'gone' }] }),
    ).toThrow()
    expect(() => StudySnapshotSchema.parse({ ...withOff, missing: [early] })).toThrow()
  })

  it('refuses a row with a bad outcome or price', () => {
    expect(() =>
      StudySnapshotSchema.parse({ ...snap, rows: [{ ...rows[0], outcome: 'draw' }] }),
    ).toThrow()
    expect(() =>
      StudySnapshotSchema.parse({ ...snap, rows: [{ ...rows[0], initialPriceBps: 10_001 }] }),
    ).toThrow()
  })
})
