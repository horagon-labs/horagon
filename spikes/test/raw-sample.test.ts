// The sampling rule behind `s4:compact --raw`: which scoreboard lines and which detail lines
// (box score, summary) of a recorded game are worth keeping as parser-test fixtures, and how
// the kept lines are trimmed of third-party editorial, media and odds content.
import { describe, expect, it } from 'vitest'
import {
  type DetailLine,
  pickDetailLines,
  type SampleFrame,
  sampleScoreboardTimes,
  TRIMMED_KEYS,
  trimRecord,
} from '../src/lib/raw-sample'

const frame = (
  t: string,
  status: string,
  period: number,
  source: 'nba' | 'espn' = 'espn',
): SampleFrame => ({ t, source, status, period })

describe('sampleScoreboardTimes', () => {
  it('keeps first, last and both sides of every status or period change', () => {
    const frames = [
      frame('t00', 'pre', 0),
      frame('t01', 'pre', 0),
      frame('t02', 'live', 1),
      frame('t03', 'live', 1),
      frame('t04', 'live', 1),
      frame('t05', 'live', 2),
      frame('t06', 'live', 2),
      frame('t07', 'live', 3),
      frame('t08', 'live', 3),
      frame('t09', 'live', 4),
      frame('t10', 'live', 4),
      frame('t11', 'final', 4),
    ]
    expect(sampleScoreboardTimes(frames).espn).toEqual([
      't00', // first
      't01', // last before live
      't02', // first live
      't04', // last of period 1
      't05',
      't06',
      't07',
      't08',
      't09',
      't10', // last live frame
      't11', // final, also the last frame
    ])
  })

  it('keeps a lone frame once', () => {
    expect(sampleScoreboardTimes([frame('t00', 'final', 4)]).espn).toEqual(['t00'])
  })

  it('keeps only the endpoints of a game that never changes', () => {
    const frames = [frame('t00', 'live', 2), frame('t01', 'live', 2), frame('t02', 'live', 2)]
    expect(sampleScoreboardTimes(frames).espn).toEqual(['t00', 't02'])
  })

  it('returns nothing for no frames', () => {
    expect(sampleScoreboardTimes([])).toEqual({ nba: [], espn: [] })
  })

  it('judges each source against its own previous frame', () => {
    // Read across sources, the nba frame at t3 would look like a change after the espn frame at
    // t2. Read per source it is not: the nba status stays 'pre' until t6.
    const frames = [
      frame('t1', 'pre', 0, 'nba'),
      frame('t2', 'live', 1, 'espn'),
      frame('t3', 'pre', 0, 'nba'),
      frame('t4', 'live', 1, 'espn'),
      frame('t5', 'pre', 0, 'nba'),
      frame('t6', 'live', 1, 'nba'),
      frame('t7', 'live', 2, 'espn'),
    ]
    const kept = sampleScoreboardTimes(frames)
    expect(kept.nba).toEqual(['t1', 't5', 't6'])
    expect(kept.espn).toEqual(['t2', 't4', 't7'])
  })
})

describe('pickDetailLines', () => {
  const body = (t: string): DetailLine => ({ t, hasBody: true })
  const same = (t: string): DetailLine => ({ t, hasBody: false })

  it('picks the first bodied line at or after each kept time', () => {
    const details = [body('t10'), body('t20'), body('t30'), body('t40')]
    // t20 is hit exactly, t25 falls between lines, t05 is before them all.
    expect(pickDetailLines(details, ['t05', 't20', 't25'])).toEqual([0, 1, 2, 3])
    expect(pickDetailLines(details, ['t20'])).toEqual([1, 3])
  })

  it('skips records without a body', () => {
    const details = [body('t10'), same('t20'), same('t30'), body('t40'), same('t50')]
    // t20 lands on a same-record: the next bodied line is index 3. The last bodied line is
    // index 3 too, not the trailing same-record.
    expect(pickDetailLines(details, ['t20'])).toEqual([3])
  })

  it('never picks a line twice', () => {
    const details = [body('t10'), body('t50')]
    expect(pickDetailLines(details, ['t20', 't30', 't40', 't50'])).toEqual([1])
  })

  it('always picks the last bodied line, even when no kept time reaches it', () => {
    const details = [body('t10'), body('t20'), body('t30')]
    expect(pickDetailLines(details, ['t10'])).toEqual([0, 2])
    expect(pickDetailLines(details, [])).toEqual([2])
  })

  it('ignores a kept time after every detail line', () => {
    const details = [body('t10'), body('t20')]
    expect(pickDetailLines(details, ['t99'])).toEqual([1])
  })

  it('picks nothing when no line has a body', () => {
    expect(pickDetailLines([same('t10'), same('t20')], ['t10'])).toEqual([])
    expect(pickDetailLines([], ['t10'])).toEqual([])
  })
})

describe('trimRecord', () => {
  const head = { t: 't1', src: 'espn-summary', url: 'u', status: 200, ms: 12, etag: 'e' }

  it('removes the listed keys at any depth, in objects and arrays alike', () => {
    const record = {
      ...head,
      body: {
        header: { id: '7', odds: [{ spread: -3 }], competitions: [{ broadcasts: ['TNT'], n: 1 }] },
        events: [
          {
            id: 'a',
            leaders: [{ name: 'x' }],
            competitions: [{ tickets: {}, highlights: [{ headline: 'clip' }], status: 'in' }],
          },
          [{ videos: [1, 2], keep: true }],
        ],
        plays: [{ id: 'p1' }],
        boxscore: { teams: ['MEM', 'CLE'] },
      },
    }
    expect(trimRecord(record).body).toEqual({
      header: { id: '7', competitions: [{ n: 1 }] },
      events: [{ id: 'a', competitions: [{ status: 'in' }] }, [{ keep: true }]],
      boxscore: { teams: ['MEM', 'CLE'] },
    })
  })

  it('lists, sorted and once, only the keys it removed', () => {
    const record = {
      ...head,
      body: {
        plays: [],
        a: { news: 1 },
        b: [{ news: 2, odds: 3 }],
        // Near misses stay: only the exact key names are removed.
        newsletter: 'kept',
        playId: 'kept',
        articles: 'kept',
      },
    }
    const out = trimRecord(record)
    expect(out.trimmed).toEqual(['news', 'odds', 'plays'])
    expect(out.body).toEqual({
      a: {},
      b: [{}],
      newsletter: 'kept',
      playId: 'kept',
      articles: 'kept',
    })
  })

  it('removes every key of TRIMMED_KEYS', () => {
    for (const key of TRIMMED_KEYS) {
      const out = trimRecord({ ...head, body: { keep: 1, [key]: { deep: [1] } } })
      expect(out.body).toEqual({ keep: 1 })
      expect(out.trimmed).toEqual([key])
    }
    expect([...TRIMMED_KEYS].sort()).toEqual(
      [
        'article',
        'againstTheSpread',
        'broadcasts',
        'geoBroadcasts',
        'headlines',
        'highlights',
        'injuries',
        'leaders',
        'news',
        'odds',
        'pickcenter',
        'plays',
        'tickets',
        'videos',
      ].sort(),
    )
  })

  it('keeps the other fields of the record as recorded', () => {
    const out = trimRecord({ ...head, body: { news: [], score: 1 } })
    expect(out).toEqual({ ...head, body: { score: 1 }, trimmed: ['news'] })
  })

  it('returns a record with nothing to remove equal to itself, without a trimmed field', () => {
    const plain = { ...head, body: { events: [{ id: 'a', status: { period: 2 } }], n: null } }
    const out = trimRecord(plain)
    expect(out).toEqual(plain)
    expect(out).not.toHaveProperty('trimmed')
  })

  it('passes records without a body through untouched', () => {
    const same = { t: 't1', src: 'espn-summary', url: 'u', status: 200, ms: 5, same: true }
    const nullBody = { ...head, body: null }
    const error = { t: 't1', src: 'espn-summary', url: 'u', error: 'fetch failed' }
    for (const record of [same, nullBody, error]) {
      const out = trimRecord(record)
      expect(out).toEqual(record)
      expect(out).not.toHaveProperty('trimmed')
    }
  })

  it('does not change the record it was given', () => {
    const record = { ...head, body: { news: [{ odds: 1 }], keep: [{ plays: 2, n: 3 }] } }
    const before = structuredClone(record)
    trimRecord(record)
    expect(record).toEqual(before)
  })
})
