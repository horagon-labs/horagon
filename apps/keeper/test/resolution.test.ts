import { createHash } from 'node:crypto'
import { parseResolutionEvidence } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import { applyResults, marginSigma, p0For, type Ratings, seasonOf } from '../src/elo'
import { buildEvidence, checkBoxScoreUrl, sealEvidence } from '../src/evidence'
import { heartbeatStale, parsePeriods, parseScore, solToLamports } from '../src/ops/args'
import { LAMPORTS_PER_MARKET, topUpTarget, transferAmount } from '../src/treasury'

const game = { league: 'NBA', externalId: '401910007', home: 'CLE', away: 'MEM' }
const draft = {
  status: 'final',
  homeScore: 111,
  awayScore: 106,
  periods: [
    [30, 25],
    [28, 27],
    [26, 30],
    [27, 24],
  ] as Array<[number, number]>,
  sourceUrl:
    'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261118',
  fetchedAt: new Date('2026-11-19T02:20:00.250Z'),
}
const confirmedAt = new Date('2026-11-19T02:31:09.900Z')

describe('evidence', () => {
  it('builds valid evidence with both sources and a YES for a home win', () => {
    const e = buildEvidence({
      game,
      draft,
      kind: 0,
      confirmUrl: 'https://www.nba.com/game/mem-vs-cle-0022600231/box-score',
      confirmSource: 'nba',
      confirmedAt,
    })
    expect(e).toMatchObject({
      gameId: '401910007',
      outcome: 'yes',
      rule: 'winner-incl-ot',
      status: 'final',
    })
    expect(e.sources).toEqual([
      { name: 'espn', url: draft.sourceUrl, fetchedAt: '2026-11-19T02:20:00Z' },
      {
        name: 'nba',
        url: 'https://www.nba.com/game/mem-vs-cle-0022600231/box-score',
        fetchedAt: '2026-11-19T02:31:09Z',
      },
    ])
  })

  it('hashes exactly the canonical bytes it returns', async () => {
    const e = buildEvidence({
      game,
      draft,
      kind: 0,
      confirmUrl: 'https://www.nba.com/x',
      confirmSource: 'nba',
      confirmedAt,
    })
    const sealed = await sealEvidence(e)
    expect(sealed.hashHex).toBe(createHash('sha256').update(sealed.json, 'utf8').digest('hex'))
    expect(JSON.parse(sealed.json)).toEqual(parseResolutionEvidence(JSON.parse(sealed.json)))
    expect(sealed.json.startsWith('{"away":"MEM","awayScore":106,')).toBe(true)
  })

  it('resolves a postponed game NO with no periods', () => {
    const e = buildEvidence({
      game,
      draft: { ...draft, status: 'postponed' },
      kind: 0,
      confirmUrl: 'https://www.nba.com/news/postponed',
      confirmSource: 'notice',
      confirmedAt,
    })
    expect(e).toMatchObject({ outcome: 'no', status: 'postponed', periods: [], homeScore: 0 })
  })

  it('refuses periods that do not add up', () => {
    const bad = { ...draft, periods: draft.periods.slice(0, 3) }
    expect(() =>
      buildEvidence({
        game,
        draft: bad,
        kind: 0,
        confirmUrl: 'https://www.nba.com/x',
        confirmSource: 'nba',
        confirmedAt,
      }),
    ).toThrow(/at least 4 periods/)
  })

  it('accepts only https box scores from nba.com, basketball-reference.com and (warned) espn.com', () => {
    expect(checkBoxScoreUrl('https://www.nba.com/game/x/box-score')).toEqual({
      ok: true,
      source: 'nba',
      url: 'https://www.nba.com/game/x/box-score',
    })
    expect(checkBoxScoreUrl('https://www.basketball-reference.com/boxscores/x.html')).toMatchObject(
      { ok: true },
    )
    expect(checkBoxScoreUrl('https://www.espn.com/nba/boxscore/_/gameId/1')).toMatchObject({
      ok: true,
      warning: expect.any(String),
    })
    expect(checkBoxScoreUrl('http://www.nba.com/x')).toMatchObject({ ok: false })
    expect(checkBoxScoreUrl('https://nba.com.evil.example/x')).toMatchObject({ ok: false })
    expect(checkBoxScoreUrl('not a url')).toMatchObject({ ok: false })
  })
})

describe('elo', () => {
  const r0: Ratings = { asOf: '2025-08-01', sigma: 13, teams: {} }

  it('assigns seasons by the October start', () => {
    expect(seasonOf('2025-10-21')).toBe(2026)
    expect(seasonOf('2026-04-12')).toBe(2026)
    expect(seasonOf('2026-10-20')).toBe(2027)
  })

  it('moves ratings zero-sum and regresses toward 1505 at a new season', () => {
    const r = applyResults(r0, [
      { date: '2026-04-01', home: 'CLE', away: 'MEM', homeScore: 110, awayScore: 100 },
      { date: '2026-10-21', home: 'MEM', away: 'BOS', homeScore: 100, awayScore: 90 },
    ])
    const cle = r.teams.CLE ?? 0
    const mem = r.teams.MEM ?? 0
    // CLE gained 20 * (1 - 0.64) = 7.2, then kept 75% of it at the season change.
    expect(cle).toBeCloseTo(1505 + 0.75 * 7.2, 0)
    expect(mem + (r.teams.BOS ?? 0) + cle).toBeCloseTo(3 * 1505, 6)
    expect(r.asOf).toBe('2026-10-21')
  })

  it('ignores results on or before asOf and gives p0 with home advantage, clamped', () => {
    const r = applyResults({ ...r0, asOf: '2026-04-01' }, [
      { date: '2026-04-01', home: 'CLE', away: 'MEM', homeScore: 110, awayScore: 100 },
    ])
    expect(r.teams).toEqual({})
    expect(p0For(r, 'CLE', 'MEM')).toBeCloseTo(0.64, 2)
    expect(p0For({ ...r, teams: { A: 2500, B: 1000 } }, 'A', 'B')).toBe(0.95)
  })

  it('computes sigma from home margins', () => {
    expect(
      marginSigma([
        { date: 'd', home: 'A', away: 'B', homeScore: 110, awayScore: 100 },
        { date: 'd', home: 'A', away: 'B', homeScore: 90, awayScore: 100 },
      ]),
    ).toBe(10)
  })
})

describe('treasury and ops helpers', () => {
  it('targets next night + 20%, rounded up to whole mUSDC', () => {
    expect(topUpTarget([1_000_000_000n, 300_000_000n])).toBe(1_560_000_000n)
    expect(topUpTarget([])).toBe(0n)
    expect(topUpTarget([1n])).toBe(1_000_000n)
  })

  it('budgets a 12-game night of winner markets (spec 6.3)', () => {
    // 4 featured at 1000 mUSDC, 8 others at 300: 6,400 mUSDC, 7,680 with the 20% margin, which
    // is 8 hourly faucet claims. Second-half markets (Tier 3) add 300 per game.
    const seeds = [...Array(4).fill(1_000_000_000n), ...Array(8).fill(300_000_000n)]
    expect(topUpTarget(seeds)).toBe(7_680_000_000n)
    // S1 and S2 measured 0.03538 SOL of rent per market: 12 markets need at least 0.4246 SOL.
    expect(12n * LAMPORTS_PER_MARKET).toBeGreaterThanOrEqual(424_560_000n)
  })

  it('moves only what is missing, capped by what the keeper holds', () => {
    expect(transferAmount(500n, 10_000n, 2_000n)).toBe(1_500n)
    expect(transferAmount(500n, 700n, 2_000n)).toBe(700n)
    expect(transferAmount(3_000n, 700n, 2_000n)).toBe(0n)
  })

  it('parses scores, periods and SOL amounts strictly', () => {
    expect(parseScore('112-108')).toEqual([112, 108])
    expect(() => parseScore('112:108')).toThrow()
    expect(parsePeriods('30-25,28-27,26-30,27-24')).toHaveLength(4)
    expect(() => parsePeriods('30-25,28-27')).toThrow()
    expect(solToLamports('0.5')).toBe(500_000_000)
    expect(() => solToLamports('50')).toThrow()
    expect(() => solToLamports('-1')).toThrow()
  })

  it('pages on a stale heartbeat only around games', () => {
    const tip = 10_000_000
    expect(heartbeatStale(300, [tip], tip + 3600)).toBe(true)
    expect(heartbeatStale(null, [tip], tip - 3600)).toBe(true)
    expect(heartbeatStale(60, [tip], tip)).toBe(false)
    expect(heartbeatStale(300, [tip], tip + 5 * 3600)).toBe(false)
    expect(heartbeatStale(300, [], tip)).toBe(false)
  })
})

describe('strict inputs', () => {
  it('normalises box-score URLs and refuses userinfo and ports', () => {
    expect(checkBoxScoreUrl('  HTTPS://WWW.NBA.COM/game/x  ')).toEqual({
      ok: true,
      source: 'nba',
      url: 'https://www.nba.com/game/x',
    })
    expect(checkBoxScoreUrl('https://user:pw@www.nba.com/x')).toMatchObject({ ok: false })
    expect(checkBoxScoreUrl('https://user@www.nba.com/x')).toMatchObject({ ok: false })
    expect(checkBoxScoreUrl('https://www.nba.com:8443/x')).toMatchObject({ ok: false })
    expect(checkBoxScoreUrl('https://www.nba.com:443/x')).toMatchObject({ ok: true })
    expect(checkBoxScoreUrl(`https://www.nba.com/${'a'.repeat(300)}`)).toMatchObject({ ok: false })
  })

  it('never turns a live draft into evidence', () => {
    expect(() =>
      buildEvidence({
        game,
        draft: { ...draft, status: 'live' },
        kind: 0,
        confirmUrl: 'https://www.nba.com/x',
        confirmSource: 'nba',
        confirmedAt,
      }),
    ).toThrow(/final or postponed/)
  })

  it('parses SOL amounts like the SDK parses token amounts', () => {
    expect(solToLamports('1.5')).toBe(1_500_000_000)
    expect(solToLamports('0.000000001')).toBe(1)
    expect(solToLamports('10')).toBe(10_000_000_000)
    expect(() => solToLamports('10.000000001')).toThrow(/\(0, 10\]/)
    expect(solToLamports('20', 20)).toBe(20_000_000_000)
    for (const bad of [
      '0x1',
      '0b1',
      '0o7',
      '1e0',
      '1e-9',
      ' 2 ',
      '+1',
      '-1',
      '.5',
      '5.',
      '0',
      '0.0',
      '0.0000000001',
      '1.0000000004',
      '01',
      '',
      '1000',
    ])
      expect(() => solToLamports(bad), bad).toThrow()
    for (const max of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5])
      expect(() => solToLamports('1', max), String(max)).toThrow(/max/)
  })

  it('gives periods their own error and rejects 13 periods', () => {
    expect(() => parsePeriods('30-25,x,26-30,27-24')).toThrow(/--periods must look like/)
    expect(() => parsePeriods('30-25,x,26-30,27-24')).not.toThrow(/--score/)
    expect(() => parsePeriods(Array(13).fill('1-1').join(','))).toThrow(/4 to 12/)
  })

  it('refuses periods whose sums differ from the final score', () => {
    expect(() =>
      buildEvidence({
        game,
        draft: { ...draft, homeScore: 112 },
        kind: 0,
        confirmUrl: 'https://www.nba.com/x',
        confirmSource: 'nba',
        confirmedAt,
      }),
    ).toThrow()
  })
})
