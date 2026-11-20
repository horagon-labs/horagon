import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { HoragonError } from '../../src/errors'
import { canonicalize } from '../../src/evidence/canonicalize'
import { evidenceHash, evidenceHashBytes, toHex } from '../../src/evidence/hash'
import type { ResolutionEvidence } from '../../src/evidence/types'

const SAMPLE: ResolutionEvidence = {
  v: 1,
  league: 'NBA',
  gameId: '0022600123',
  kind: 0,
  home: 'BOS',
  away: 'LAL',
  homeScore: 112,
  awayScore: 108,
  periods: [
    [28, 25],
    [30, 27],
    [26, 30],
    [28, 26],
  ],
  status: 'final',
  rule: 'winner-incl-ot',
  outcome: 'yes',
  sources: [
    {
      name: 'nba-cdn',
      url: 'https://cdn.nba.com/static/json/liveData/boxscore/boxscore_0022600123.json',
      fetchedAt: '2026-11-25T03:01:12Z',
    },
    {
      name: 'espn',
      url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=401700123',
      fetchedAt: '2026-11-25T03:01:15Z',
    },
  ],
}

// Golden values from Python: json.dumps(SAMPLE, sort_keys=True, separators=(',', ':'),
// ensure_ascii=False), then hashlib.sha256(...).hexdigest().
const SAMPLE_JCS =
  '{"away":"LAL","awayScore":108,"gameId":"0022600123","home":"BOS","homeScore":112,"kind":0,"league":"NBA","outcome":"yes","periods":[[28,25],[30,27],[26,30],[28,26]],"rule":"winner-incl-ot","sources":[{"fetchedAt":"2026-11-25T03:01:12Z","name":"nba-cdn","url":"https://cdn.nba.com/static/json/liveData/boxscore/boxscore_0022600123.json"},{"fetchedAt":"2026-11-25T03:01:15Z","name":"espn","url":"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=401700123"}],"status":"final","v":1}'
const SAMPLE_HASH = 'a90ff599b34aab143795d53364ef2eb5f7e01a534f6289b4c980bbe9598fc9d6'

describe('canonicalize', () => {
  it('matches the Python golden string', () => {
    expect(canonicalize(SAMPLE)).toBe(SAMPLE_JCS)
  })

  it('sorts keys by UTF-16 code units and escapes like JSON.stringify', () => {
    expect(canonicalize({ b: 1, a: [true, null, 'x"\n\u00e9'], A: -0 })).toBe(
      '{"A":0,"a":[true,null,"x\\"\\n\u00e9"],"b":1}',
    )
  })

  it('orders a key outside the BMP by its UTF-16 surrogates, not by code point', async () => {
    // RFC 8785 3.2.3. U+1F3C0 (surrogates D83C DFC0) sorts before U+FB01 in UTF-16 order, after
    // it by code point. Python's sort_keys=True orders by code point, so a Python verifier must
    // sort with key=lambda k: k.encode('utf-16-be'). Golden hash from that Python code.
    const value = { ﬁ: 1, '\u{1F3C0}': 2, z: 3 }
    expect(canonicalize(value)).toBe('{"z":3,"\u{1F3C0}":2,"ﬁ":1}')
    expect(await evidenceHash(value)).toBe(
      'a4678b707445c9a53e7e7ad6a16acca0ca8c9c2b5b3019e3dccfbdcaad8e488e',
    )
  })

  it.each([
    ['a float', { x: 1.5 }],
    ['an unsafe integer', { x: 2 ** 53 }],
    ['NaN', [Number.NaN]],
    ['undefined', { x: undefined }],
    ['a bigint', { x: 1n }],
    ['a Date', { x: new Date(0) }],
    ['a lone surrogate', { x: '\uD800' }],
    // biome-ignore lint/suspicious/noSparseArray: holes must be rejected, not skipped
    ['a sparse array', [1, , 3]],
  ])('rejects %s', (_label, value) => {
    expect(() => canonicalize(value)).toThrow(HoragonError)
  })

  it('names the offending path', () => {
    expect(() => canonicalize({ periods: [[1, 2.5]] })).toThrow('$.periods[0][1]')
  })

  it('does not depend on key insertion order, and is idempotent', () => {
    const json = fc.letrec((tie) => ({
      value: fc.oneof(
        { depthSize: 'small' },
        fc.string(),
        fc.maxSafeInteger(),
        fc.boolean(),
        fc.constant(null),
        fc.array(tie('value'), { maxLength: 4 }),
        fc.dictionary(fc.string(), tie('value'), { maxKeys: 4 }),
      ),
    })).value
    fc.assert(
      fc.property(json, (value) => {
        const canonical = canonicalize(value)
        expect(canonicalize(JSON.parse(canonical))).toBe(canonical)
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const reversed = Object.fromEntries(Object.entries(value).reverse())
          expect(canonicalize(reversed)).toBe(canonical)
        }
      }),
    )
  })
})

describe('evidenceHash', () => {
  it('matches the Python golden hash', async () => {
    expect(await evidenceHash(SAMPLE)).toBe(SAMPLE_HASH)
  })

  it('returns the same digest as 32 bytes', async () => {
    const bytes = await evidenceHashBytes(SAMPLE)
    expect(bytes).toHaveLength(32)
    expect(toHex(bytes)).toBe(SAMPLE_HASH)
  })

  it('changes when any field changes', async () => {
    expect(await evidenceHash({ ...SAMPLE, awayScore: 109 })).not.toBe(SAMPLE_HASH)
  })
})
