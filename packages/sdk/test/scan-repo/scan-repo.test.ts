// Black-box tests of scripts/scan-repo.mjs: each test spawns the script on a throwaway repository
// (see fixture-repo.ts) and every run is checked for leaks of matched text, paths, ref names,
// identities and offsets.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  buildMainFixture,
  FixtureRepo,
  identity,
  leaks,
  type MainCommits,
  NOBODY,
  PROJECT,
  type ScanResult,
} from './fixture-repo'

// Word edges that, unlike the ASCII-only backslash-b, know accented letters.
const EDGE_L = '(?<![\\p{L}\\p{N}_])'
const EDGE_R = '(?![\\p{L}\\p{N}_])'

// Fake patterns only. Line 1 is a comment and line 3 is blank, so the patterns are #2, #4 and #5.
const DENYLIST = [
  '# fixture denylist: fake values only',
  EDGE_L + 'QZX' + EDGE_R,
  '',
  'zebraname',
  'fake@example\\.test',
]
const MATCHED = ['qzx', 'zebraname', 'zébraname', 'example.test']

const hitLines = (result: ScanResult): string[] => result.stdout.trim().split('\n').slice(1, -1)
const linesOf = (result: ScanResult, sha: string): string[] =>
  hitLines(result).filter((line) => line.includes(`commit=${sha} `))

function scan(repo: FixtureRepo, args: string[] = [], env: NodeJS.ProcessEnv = {}): ScanResult {
  const result = repo.scan(args, env)
  expect(leaks(repo, result, MATCHED)).toEqual([])
  return result
}

describe('scan-repo on the main fixture', { timeout: 60_000 }, () => {
  let repo: FixtureRepo
  let c: MainCommits
  let base: ScanResult

  const content = (sha: string, path: string, pattern: number) =>
    `HIT content commit=${sha} path#=${repo.pathNumber(sha, path)} pattern#=${pattern}`
  const pathHit = (sha: string, path: string, pattern: number) =>
    `HIT path commit=${sha} path#=${repo.pathNumber(sha, path)} pattern#=${pattern}`

  const expectedDefault = (): string[] => [
    content(c.c1, 'src/carry.txt', 2),
    content(c.c2, 'src/copy.txt', 2),
    pathHit(c.c2, 'zebraname-dir/plain é.txt', 4),
    `HIT message commit=${c.c3} pattern#=2`,
    `HIT identity commit=${c.c4} field=author pattern#=4`,
    `HIT identity commit=${c.c4} field=author pattern#=5`,
    `HIT offset commit=${c.c4} field=author`,
    `HIT offset commit=${c.c5} field=committer`,
    content(c.b1, 'docs/bravo.md', 4),
    content(c.c6, 'docs/clean.md', 2),
    `HIT identity commit=${c.c6} field=committer pattern#=4`,
    `HIT identity commit=${c.c6} field=committer pattern#=5`,
    content(c.merge, 'docs/merge-only.md', 2),
    content(c.wip, 'notes/wip.txt', 4),
    `HIT offset commit=${c.wip} field=author`,
    content(c.skipped, 'notes/skip.txt', 2),
    content(c.light, 'notes/light.txt', 2),
    'HIT ref ref#=5 pattern#=2',
    'HIT ref ref#=8 pattern#=2',
    'HIT tag ref#=9 field=annotation pattern#=2',
    'HIT tag ref#=9 field=tagger pattern#=4',
    'HIT tag ref#=9 field=tagger pattern#=5',
    'HIT tag ref#=9 field=tagger-offset',
    'HIT ref ref#=10 pattern#=2',
    'HIT ref ref#=11 pattern#=2',
  ]

  beforeAll(() => {
    const fixture = buildMainFixture()
    repo = fixture.repo
    c = fixture.commits
    repo.keys({ denylist: DENYLIST })
    base = scan(repo)
  }, 120_000)

  afterAll(() => repo.cleanup())

  it('prints the header, exactly the expected hits and the result line, and exits 1', () => {
    expect(base.status).toBe(1)
    expect(base.stderr).toBe('')
    const lines = base.stdout.trim().split('\n')
    expect(lines[0]).toBe('scan-repo: 11 refs, 13 commits, 17 blobs, 14 paths, 3 patterns')
    expect(hitLines(base).sort()).toEqual(expectedDefault().sort())
    expect(lines.at(-1)).toBe('result: 25 hits (0 accepted)')
  })

  it('reports a carried file once, at the commit that introduced it', () => {
    expect(linesOf(base, c.c1)).toEqual([content(c.c1, 'src/carry.txt', 2)])
    // the same blob at a new path is a new introduction
    expect(linesOf(base, c.c2)).toContain(content(c.c2, 'src/copy.txt', 2))
    // c6 edits docs/clean.md, which exists since c1: its new blob is a new introduction
    expect(linesOf(base, c.c6)).toContain(content(c.c6, 'docs/clean.md', 2))
    // c7 changes carry.txt and the zebraname-dir file (a path already reported at c2);
    // c8 restores the carry.txt blob already reported at c1
    expect(linesOf(base, c.c7)).toEqual([])
    expect(linesOf(base, c.c8)).toEqual([])
  })

  it('reports nothing for a merge that only combines what its parents had', () => {
    // bravo.md comes from b1 and carry.txt from c1: only the merge's own new file is reported
    expect(linesOf(base, c.merge)).toEqual([content(c.merge, 'docs/merge-only.md', 2)])
    expect(linesOf(base, c.b1)).toEqual([content(c.b1, 'docs/bravo.md', 4)])
  })

  it('reports a path hit (here a directory name) by its ls-tree number', () => {
    expect(linesOf(base, c.c2)).toEqual([
      content(c.c2, 'src/copy.txt', 2),
      pathHit(c.c2, 'zebraname-dir/plain é.txt', 4),
    ])
  })

  it('matches case-insensitively in messages and content', () => {
    // pattern QZX (with word edges) against "Qzx" in the message, pattern zebraname against "ZEBRANAME"
    expect(linesOf(base, c.c3)).toEqual([`HIT message commit=${c.c3} pattern#=2`])
    expect(linesOf(base, c.wip)).toEqual([
      content(c.wip, 'notes/wip.txt', 4),
      `HIT offset commit=${c.wip} field=author`,
    ])
  })

  it('matches QZX with word edges against qzx but not inside PREQZX or QZXPOST', () => {
    const prefix = `commit=${c.c1} path#=${repo.pathNumber(c.c1, 'src/prefix.txt')} `
    expect(hitLines(base).filter((line) => line.includes(prefix))).toEqual([])
    expect(hitLines(base)).toContain(content(c.c1, 'src/carry.txt', 2))
  })

  it('reports author and committer identities that match a pattern', () => {
    expect(linesOf(base, c.c4)).toEqual(
      expect.arrayContaining([
        `HIT identity commit=${c.c4} field=author pattern#=4`,
        `HIT identity commit=${c.c4} field=author pattern#=5`,
      ]),
    )
    expect(linesOf(base, c.c6)).toEqual([
      content(c.c6, 'docs/clean.md', 2),
      `HIT identity commit=${c.c6} field=committer pattern#=4`,
      `HIT identity commit=${c.c6} field=committer pattern#=5`,
    ])
    // without --identity an identity that matches no pattern is fine
    expect(linesOf(base, c.c5)).toEqual([`HIT offset commit=${c.c5} field=committer`])
  })

  it('reports identities missing from the --identity allow list', () => {
    const result = scan(repo, ['--identity', identity(PROJECT)])
    expect(result.status).toBe(1)
    const nobody = `HIT identity commit=${c.c5} field=author reason=not-allowed`
    const added = [
      `HIT identity commit=${c.c4} field=author reason=not-allowed`,
      nobody,
      `HIT identity commit=${c.c6} field=committer reason=not-allowed`,
      'HIT tag ref#=9 field=tagger reason=not-allowed',
    ]
    expect(hitLines(result).sort()).toEqual([...expectedDefault(), ...added].sort())
    expect(result.stdout).toContain('result: 29 hits (0 accepted)')
    const both = scan(repo, ['--identity', identity(PROJECT), '--identity', identity(NOBODY)])
    expect(hitLines(both)).not.toContain(nobody)
    expect(both.stdout).toContain('result: 28 hits (0 accepted)')
    // the allow list is exact: the same identity in another letter case is not on it
    const lower = scan(repo, ['--identity', identity(PROJECT).toLowerCase()])
    expect(linesOf(lower, c.c1)).toEqual([
      content(c.c1, 'src/carry.txt', 2),
      `HIT identity commit=${c.c1} field=author reason=not-allowed`,
      `HIT identity commit=${c.c1} field=committer reason=not-allowed`,
    ])
  })

  it('reports every author, committer and tagger offset other than +0000', () => {
    const offsets = hitLines(base).filter((line) => / offset |tagger-offset/.test(line))
    expect(offsets.sort()).toEqual(
      [
        `HIT offset commit=${c.c4} field=author`,
        `HIT offset commit=${c.c5} field=committer`,
        `HIT offset commit=${c.wip} field=author`,
        'HIT tag ref#=9 field=tagger-offset',
      ].sort(),
    )
  })

  it('reports ref-name hits as ref# only, including the name stored in a tag object', () => {
    // 5 and 8: the qzx-echo branch and its remote copy; 10: the golf-qzx-light tag;
    // 11: a tag created as qzx-inner, renamed
    const refs = hitLines(base).filter((line) => line.startsWith('HIT ref '))
    expect(refs).toEqual([
      'HIT ref ref#=5 pattern#=2',
      'HIT ref ref#=8 pattern#=2',
      'HIT ref ref#=10 pattern#=2',
      'HIT ref ref#=11 pattern#=2',
    ])
  })

  it('reports the annotation, tagger and tagger offset of an annotated tag', () => {
    expect(hitLines(base).filter((line) => line.startsWith('HIT tag '))).toEqual([
      'HIT tag ref#=9 field=annotation pattern#=2',
      'HIT tag ref#=9 field=tagger pattern#=4',
      'HIT tag ref#=9 field=tagger pattern#=5',
      'HIT tag ref#=9 field=tagger-offset',
    ])
  })

  it('scans unpushed local branches and lightweight tags', () => {
    expect(linesOf(base, c.wip)).toEqual([
      content(c.wip, 'notes/wip.txt', 4),
      `HIT offset commit=${c.wip} field=author`,
    ])
    expect(linesOf(base, c.skipped)).toEqual([content(c.skipped, 'notes/skip.txt', 2)])
    expect(linesOf(base, c.light)).toEqual([content(c.light, 'notes/light.txt', 2)])
  })

  it('leaves a --skip branch out of scope, by short or full name', () => {
    const short = scan(repo, ['--skip', 'delta-skipme'])
    const full = scan(repo, ['--skip', 'refs/heads/delta-skipme'])
    expect(full.stdout).toBe(short.stdout)
    expect(short.status).toBe(1)
    expect(short.stdout).not.toContain(c.skipped)
    const lines = short.stdout.trim().split('\n')
    expect(lines[0]).toBe('scan-repo: 10 refs, 12 commits, 16 blobs, 13 paths, 3 patterns')
    expect(hitLines(short).filter((line) => /^HIT (ref|tag) /.test(line))).toEqual([
      'HIT ref ref#=4 pattern#=2',
      'HIT ref ref#=7 pattern#=2',
      'HIT tag ref#=8 field=annotation pattern#=2',
      'HIT tag ref#=8 field=tagger pattern#=4',
      'HIT tag ref#=8 field=tagger pattern#=5',
      'HIT tag ref#=8 field=tagger-offset',
      'HIT ref ref#=9 pattern#=2',
      'HIT ref ref#=10 pattern#=2',
    ])
    expect(lines.at(-1)).toBe('result: 24 hits (0 accepted)')
  })

  it('never scans refs/original, refs/stash, refs/notes or another remote', () => {
    expect(base.stdout).not.toContain(c.original)
    expect(base.stdout).not.toContain(c.mirror)
  })

  it('scans the remote named by --remote instead of origin', () => {
    const result = scan(repo, ['--remote', 'hotel-remote'])
    const lines = result.stdout.trim().split('\n')
    expect(lines[0]).toBe('scan-repo: 9 refs, 14 commits, 18 blobs, 15 paths, 3 patterns')
    expect(hitLines(result)).toContain(content(c.mirror, 'notes/mirror.txt', 2))
    expect(hitLines(result).filter((line) => line.startsWith('HIT ref '))).toEqual([
      'HIT ref ref#=5 pattern#=2',
      'HIT ref ref#=8 pattern#=2',
      'HIT ref ref#=9 pattern#=2',
    ])
    expect(hitLines(result)).toContain('HIT tag ref#=7 field=annotation pattern#=2')
  })

  it('turns hits on accepted commits into ACCEPTED, never ref or tag hits', () => {
    const { c1, c2, c3, c4, c5, b1, c6, merge, wip, skipped } = c
    repo.keys({
      accepted: [
        '# accepted on review',
        c1.toUpperCase(),
        '',
        ...[c2, c3, c4, c5, b1, c6, merge, wip, skipped],
      ],
    })
    try {
      const result = scan(repo)
      expect(result.status).toBe(1)
      const accepted = new Set([c1, c2, c3, c4, c5, b1, c6, merge, wip, skipped])
      const expected = expectedDefault().map((line) => {
        const sha = /commit=([0-9a-f]{40})/.exec(line)?.[1]
        return sha !== undefined && accepted.has(sha) ? line.replace(/^HIT/, 'ACCEPTED') : line
      })
      expect(hitLines(result).sort()).toEqual(expected.sort())
      expect(hitLines(result).filter((line) => line.startsWith('HIT '))).toEqual([
        content(c.light, 'notes/light.txt', 2),
        'HIT ref ref#=5 pattern#=2',
        'HIT ref ref#=8 pattern#=2',
        'HIT tag ref#=9 field=annotation pattern#=2',
        'HIT tag ref#=9 field=tagger pattern#=4',
        'HIT tag ref#=9 field=tagger pattern#=5',
        'HIT tag ref#=9 field=tagger-offset',
        'HIT ref ref#=10 pattern#=2',
        'HIT ref ref#=11 pattern#=2',
      ])
      expect(result.stdout).toContain('result: 25 hits (16 accepted)')
    } finally {
      repo.keys({ accepted: null })
    }
  })
})

describe('scan-repo exit codes, config errors and edge cases', { timeout: 60_000 }, () => {
  let solo: FixtureRepo // one commit whose docs/solo.md holds a content hit
  let soloSha: string
  let clean: FixtureRepo // one commit with no hit

  beforeAll(() => {
    solo = new FixtureRepo('solo-trunk')
    soloSha = solo.commit('chore: start', { '.gitignore': '.keys/\n', 'docs/solo.md': 'qzx\n' })
    clean = new FixtureRepo('clean-trunk')
    clean.commit('chore: start', { '.gitignore': '.keys/\n', 'docs/clean.md': 'nothing\n' })
  }, 60_000)

  beforeEach(() => {
    solo.keys({ denylist: DENYLIST, accepted: null })
    clean.keys({ denylist: DENYLIST, accepted: null })
  })

  afterAll(() => {
    solo.cleanup()
    clean.cleanup()
  })

  const soloHit = () =>
    `content commit=${soloSha} path#=${solo.pathNumber(soloSha, 'docs/solo.md')} pattern#=2`

  it('exits 0 when there is no hit', () => {
    const result = scan(clean)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(
      'scan-repo: 1 refs, 1 commits, 2 blobs, 2 paths, 3 patterns\nresult: 0 hits (0 accepted)\n',
    )
    expect(result.stderr).toBe('')
  })

  it('exits 1 on an unaccepted hit and 0 once its commit is accepted', () => {
    const open = scan(solo)
    expect(open.status).toBe(1)
    expect(hitLines(open)).toEqual([`HIT ${soloHit()}`])
    solo.keys({ accepted: [soloSha] })
    const accepted = scan(solo)
    expect(accepted.status).toBe(0)
    expect(hitLines(accepted)).toEqual([`ACCEPTED ${soloHit()}`])
    expect(accepted.stdout).toContain('result: 1 hits (1 accepted)')
  })

  it('exits 2 when the denylist is missing', () => {
    solo.keys({ denylist: null })
    const result = scan(solo)
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('scan-repo: .keys/scan-denylist.txt is missing\n')
  })

  it('exits 2 when git does not ignore the denylist', () => {
    writeFileSync(join(solo.dir, '.gitignore'), '# nothing ignored\n')
    try {
      const result = scan(solo)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('scan-repo: .keys/scan-denylist.txt is not ignored by git\n')
    } finally {
      writeFileSync(join(solo.dir, '.gitignore'), '.keys/\n')
    }
  })

  it('exits 2 on an invalid regular expression, naming only its line', () => {
    solo.keys({ denylist: ['zebraname', '# comment', 'qzx(unclosed'] })
    const result = scan(solo)
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(
      'scan-repo: pattern#3 is not a valid regular expression (flags i, m, u)\n',
    )
  })

  it('exits 2 when the denylist has no patterns', () => {
    solo.keys({ denylist: ['# only a comment', ''] })
    const result = scan(solo)
    expect(result.status).toBe(2)
    expect(result.stderr).toBe('scan-repo: .keys/scan-denylist.txt has no patterns\n')
  })

  it('exits 2 on an accepted list line that is not a full SHA', () => {
    solo.keys({ accepted: [soloSha, 'zebraname-not-a-sha'] })
    const result = scan(solo)
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(
      'scan-repo: .keys/scan-accepted.txt line 2 is not a full 40-hex commit SHA\n',
    )
  })

  it('exits 2 with the usage on an unknown option or a missing value, without echoing it', () => {
    for (const args of [['--zebraname-option', 'value'], ['--skip']]) {
      const result = scan(solo, args)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(/^scan-repo: usage: node scripts\/scan-repo\.mjs /)
    }
  })

  it('exits 2 when --repo is missing or not inside a git work tree', () => {
    const empty = join(solo.root, 'empty-dir')
    mkdirSync(empty, { recursive: true })
    const ceiling = { GIT_CEILING_DIRECTORIES: solo.root.replaceAll('\\', '/') }
    const outside = scan(solo, ['--repo', empty], ceiling)
    expect(outside.status).toBe(2)
    expect(outside.stderr).toBe('scan-repo: --repo is not inside a git work tree\n')
    const missing = scan(solo, ['--repo', join(solo.root, 'no-such-dir')])
    expect(missing.status).toBe(2)
    expect(missing.stderr).toBe('scan-repo: the --repo directory does not exist\n')
  })

  it('reads a denylist saved with a byte order mark and CRLF line ends, lines trimmed', () => {
    // lines 2 and 3 are comments (line 3 once its leading spaces are trimmed); line 4 is the
    // pattern qzx once its leading space is trimmed
    solo.keys({ denylist: '\uFEFFqzx\r\n# comment\r\n  #x\r\n qzx\r\n' })
    const result = scan(solo)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(' 2 patterns\n')
    expect(hitLines(result)).toEqual([
      `HIT ${soloHit().replace('pattern#=2', 'pattern#=1')}`,
      `HIT ${soloHit().replace('pattern#=2', 'pattern#=4')}`,
    ])
  })

  it('trims trailing whitespace, so an invisible space cannot disable a pattern', () => {
    solo.keys({ denylist: 'qzx \t\n' })
    const result = scan(solo)
    expect(result.status).toBe(1)
    expect(hitLines(result)).toEqual([`HIT ${soloHit().replace('pattern#=2', 'pattern#=1')}`])
  })

  it('exits 2 when the denylist is not UTF-8 text', () => {
    const cases: Buffer[] = [
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('qzx\n', 'utf16le')]),
      Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('qzx\n', 'utf16le').swap16()]),
      Buffer.from('qz\0x\n'),
      Buffer.from([0x7a, 0xe9, 0x62, 0x72, 0x61, 0x0a]), // latin1 e-acute, invalid UTF-8
    ]
    for (const bytes of cases) {
      writeFileSync(join(solo.dir, '.keys', 'scan-denylist.txt'), bytes)
      const result = scan(solo)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('scan-repo: .keys/scan-denylist.txt is not UTF-8 text\n')
    }
  })

  it('exits 2 when the accepted list is not UTF-8 text', () => {
    writeFileSync(
      join(solo.dir, '.keys', 'scan-accepted.txt'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${soloSha}\n`, 'utf16le')]),
    )
    const result = scan(solo)
    expect(result.status).toBe(2)
    expect(result.stderr).toBe('scan-repo: .keys/scan-accepted.txt is not UTF-8 text\n')
  })

  // Scans a scratch repository holding `files` with `denylist`; returns the files that got a
  // content hit, by name, plus the raw result.
  function probe(denylist: string[] | string, files: Record<string, string | Uint8Array>) {
    const scratch = new FixtureRepo('probe-trunk')
    try {
      const sha = scratch.commit('chore: start', { '.gitignore': '.keys/\n', ...files })
      scratch.keys({ denylist })
      const result = scan(scratch)
      const hit = Object.keys(files).filter((path) =>
        hitLines(result).some((line) =>
          line.startsWith(`HIT content commit=${sha} path#=${scratch.pathNumber(sha, path)} `),
        ),
      )
      return { result, hit: hit.sort() }
    } finally {
      scratch.cleanup()
    }
  }

  it('translates \\b so that it knows letters, digits and underscore beyond ASCII', () => {
    const word = probe(['\\bqzx\\b'], {
      'a.txt': 'say qzx now\n',
      'b.txt': 'aqzxb\n',
      'c.txt': 'qzx_x and xqzx\n',
    })
    expect(word.hit).toEqual(['a.txt'])
    const accent = probe(['\\b\u00e9zebra\\b'], {
      'a.txt': 'the \u00c9zebra here\n',
      'b.txt': 'a\u00e9zebra\n',
    })
    expect(accent.hit).toEqual(['a.txt'])
    const notEdge = probe(['qz\\Bx'], { 'a.txt': 'qzx\n', 'b.txt': 'qz x\n' })
    expect(notEdge.hit).toEqual(['a.txt'])
  })

  it('translates \\w and \\W to Unicode letters, digits and underscore', () => {
    expect(probe(['zebranam\\w'], { 'a.txt': 'zebranam\u00e9\n' }).hit).toEqual(['a.txt'])
    expect(probe(['zeb\\w+name'], { 'a.txt': 'zeb\u01b0\u1edd name\n' }).hit).toEqual([])
    expect(probe(['zeb\\w+name'], { 'a.txt': 'zeb\u01b0\u1eddname\n' }).hit).toEqual(['a.txt'])
    expect(probe(['qz[\\w]x'], { 'a.txt': 'qz\u00e9x\n', 'b.txt': 'qz-x\n' }).hit).toEqual([
      'a.txt',
    ])
    expect(probe(['qz\\Wx'], { 'a.txt': 'qz-x\n', 'b.txt': 'qz\u00e9x\n' }).hit).toEqual(['a.txt'])
  })

  it('keeps identity escapes literal under the u flag', () => {
    expect(probe(['qzx\\-fake'], { 'a.txt': 'qzx-fake\n', 'b.txt': 'qzxxfake\n' }).hit).toEqual([
      'a.txt',
    ])
    expect(probe(['qzx\\ fake', 'q\\@z', 'q\\#z'], { 'a.txt': 'qzx fake\n' }).hit).toEqual([
      'a.txt',
    ])
    expect(probe(['[a\\-c]zx'], { 'a.txt': '-zx\n', 'b.txt': 'bzx\n' }).hit).toEqual(['a.txt'])
  })

  it('treats an escaped backslash before b as a literal backslash and the letter b', () => {
    const result = probe(['x\\\\b'], { 'a.txt': 'x\\b\n', 'b.txt': 'xb\n', 'c.txt': 'x b\n' })
    expect(result.hit).toEqual(['a.txt'])
  })

  it('exits 2 on \\W or \\b inside a character class, naming only the line', () => {
    for (const pattern of ['[\\W]', 'x[a\\b]']) {
      solo.keys({ denylist: ['# comment', pattern] })
      const result = scan(solo)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('scan-repo: pattern#2 uses \\W or \\b inside a character class\n')
    }
  })

  it('exits 2 on a pattern that is invalid under the u flag', () => {
    solo.keys({ denylist: ['qzx', 'qzx]'] })
    const result = scan(solo)
    expect(result.status).toBe(2)
    expect(result.stderr).toBe(
      'scan-repo: pattern#2 is not a valid regular expression (flags i, m, u)\n',
    )
  })

  it('exits 2 on invisible or control characters in a pattern, naming only the line', () => {
    const invisible = [
      'qzx\u200b', // zero width space
      'qz\u00adx', // soft hyphen
      'qzx\u200e', // left-to-right mark
      'qzx\u00a0fake', // no-break space inside
      'qzx\u0001',
      'qz\u2028x', // line separator
      'q\tx', // tab inside
    ]
    for (const pattern of invisible) {
      solo.keys({ denylist: ['# comment', pattern] })
      const result = scan(solo)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(
        'scan-repo: pattern#2 contains an invisible or control character\n',
      )
    }
    // CR-only line ends fold the file into one line that holds a CR
    solo.keys({ denylist: 'qzx\rfake\r' })
    const result = scan(solo)
    expect(result.status).toBe(2)
    expect(result.stderr).toBe('scan-repo: pattern#1 contains an invisible or control character\n')
  })

  it('exits 2 on an accepted list line with extra whitespace: that file is not trimmed', () => {
    solo.keys({ accepted: [` ${soloSha} `] })
    const result = scan(solo)
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(
      'scan-repo: .keys/scan-accepted.txt line 1 is not a full 40-hex commit SHA\n',
    )
  })

  it('exits 2 on a commit with a non-UTF-8 encoding header, naming only its SHA', () => {
    const latin = new FixtureRepo('latin-trunk')
    try {
      latin.commit('chore: start', { '.gitignore': '.keys/\n', 'docs/clean.md': 'clean\n' })
      latin.git(
        ...['-c', 'i18n.commitEncoding=ISO-8859-1'],
        ...['-c', 'user.name=Fixture Project', '-c', 'user.email=project@noreply.test'],
        ...['commit', '-q', '--allow-empty', '-m', 'note'],
      )
      const sha = latin.git('rev-parse', 'HEAD')
      latin.keys({ denylist: DENYLIST })
      const result = scan(latin)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`scan-repo: commit ${sha} has a non-UTF-8 encoding header\n`)
    } finally {
      latin.cleanup()
    }
  })

  it('fails closed on a range that touches \\w, and still accepts a hyphen next to it', () => {
    for (const pattern of ['zebra[\\w-z]name', 'zebra[\\w-_]name', 'zebra[a-\\w]name']) {
      solo.keys({ denylist: ['# comment', pattern] })
      const result = scan(solo)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(
        'scan-repo: pattern#2 is not a valid regular expression (flags i, m, u)\n',
      )
    }
    const files = { 'a.txt': 'zebra-name\n', 'b.txt': 'zebraXname\n' }
    for (const pattern of ['zebra[\\w-]name', 'zebra[-\\w]name', 'zebra[\\w.-]name']) {
      expect(probe([pattern], files).hit).toEqual(['a.txt', 'b.txt'])
    }
    expect(probe(['zebra[^\\w]name'], files).hit).toEqual(['a.txt'])
  })

  it('refuses an invisible character in a comment line, where it would hide a pattern', () => {
    for (const sep of ['\r', '\u2028', '\u0085', '\u000b', '\u000c']) {
      solo.keys({ denylist: `qzx\n# note${sep}zebraname\n` })
      const result = scan(solo)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(
        'scan-repo: .keys/scan-denylist.txt line 2 contains an invisible or control character\n',
      )
    }
    // a CRLF file and blank lines are still fine
    solo.keys({ denylist: '# note\r\n\r\nqzx\r\n' })
    expect(scan(solo).status).toBe(1)
  })

  it('refuses default-ignorable characters in a pattern', () => {
    // variation selector 16, combining grapheme joiner, Hangul filler
    for (const mark of ['\ufe0f', '\u034f', '\u3164']) {
      solo.keys({ denylist: [`qzx${mark}`] })
      const result = scan(solo)
      expect(result.status).toBe(2)
      expect(result.stderr).toBe(
        'scan-repo: pattern#1 contains an invisible or control character\n',
      )
    }
  })

  // A fresh repository with one clean commit, for tests that plant hand-made objects.
  function withObjects(
    run: (repo: FixtureRepo, put: (type: string, bytes: Buffer) => string, base: string) => void,
  ) {
    const repo = new FixtureRepo('objects-trunk')
    try {
      const base = repo.commit('chore: start', {
        '.gitignore': '.keys/\n',
        'docs/clean.md': 'clean\n',
      })
      repo.keys({ denylist: DENYLIST })
      const put = (type: string, bytes: Buffer) => {
        const file = join(repo.root, `object-${type}.bin`)
        writeFileSync(file, bytes)
        return repo.git('hash-object', '-t', type, '-w', '--literally', file)
      }
      run(repo, put, base)
    } finally {
      repo.cleanup()
    }
  }

  const person = `${identity(PROJECT)} 1793527200 +0000`
  const latin1 = (text: string) => Buffer.from(text, 'latin1')

  it('exits 2 on a commit that is not valid UTF-8 and has no encoding header', () => {
    withObjects((repo, put, base) => {
      const tree = repo.git('rev-parse', `${base}^{tree}`)
      const head = `tree ${tree}\nauthor ${person}\ncommitter ${person}\n\n`
      const sha = put('commit', Buffer.concat([Buffer.from(head), latin1('zébraname\n')]))
      repo.updateRef('refs/heads/lima-latin', sha)
      const result = scan(repo)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`scan-repo: commit ${sha} is not valid UTF-8\n`)
    })
  })

  it('exits 2 on an annotated tag that is not valid UTF-8 and has no encoding header', () => {
    withObjects((repo, put, base) => {
      const head = `object ${base}\ntype commit\ntag mike-note\ntagger ${person}\n\n`
      const sha = put('tag', Buffer.concat([Buffer.from(head), latin1('release zébraname\n')]))
      repo.updateRef('refs/tags/mike-note', sha)
      const result = scan(repo)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`scan-repo: tag ${sha} is not valid UTF-8\n`)
    })
  })

  it('exits 2 on an annotated tag with a non-UTF-8 encoding header, naming only its SHA', () => {
    withObjects((repo, put, base) => {
      const head = `object ${base}\ntype commit\ntag november-note\ntagger ${person}\n`
      const sha = put('tag', Buffer.from(`${head}encoding ISO-8859-1\n\nplain note\n`))
      repo.updateRef('refs/tags/november-note', sha)
      const result = scan(repo)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`scan-repo: tag ${sha} has a non-UTF-8 encoding header\n`)
    })
  })

  it('exits 2 on a tree entry name that is not valid UTF-8, naming only the commit', () => {
    withObjects((repo, put) => {
      const blob = put('blob', Buffer.from('plain\n'))
      const name = Buffer.concat([Buffer.from('100644 z'), latin1('é'), Buffer.from('bra.txt\0')])
      const tree = put('tree', Buffer.concat([name, Buffer.from(blob, 'hex')]))
      const body = `tree ${tree}\nauthor ${person}\ncommitter ${person}\n\nlatin path\n`
      const sha = put('commit', Buffer.from(body))
      repo.updateRef('refs/heads/oscar-path', sha)
      const result = scan(repo)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(`scan-repo: commit ${sha} has a path that is not valid UTF-8\n`)
    })
  })

  it('exits 2 on a ref name that is not valid UTF-8, without printing it', () => {
    withObjects((repo, _put, base) => {
      const packed = Buffer.concat([
        Buffer.from('# pack-refs with: peeled fully-peeled sorted \n'),
        Buffer.from(`${base} refs/heads/papa-z`),
        latin1('é'),
        Buffer.from('bra\n'),
      ])
      writeFileSync(join(repo.dir, '.git', 'packed-refs'), packed)
      const result = scan(repo)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('scan-repo: a ref name is not valid UTF-8\n')
    })
  })

  it('translates \\B next to a non-ASCII letter', () => {
    expect(probe(['zeb\\Bra'], { 'a.txt': 'zebra\n', 'b.txt': 'zeb ra\n' }).hit).toEqual(['a.txt'])
    const accent = probe(['é\\Bzebra'], {
      'a.txt': 'ézebra\n',
      'b.txt': 'é zebra\n',
    })
    expect(accent.hit).toEqual(['a.txt'])
  })

  it('matches UTF-16 at an odd offset and text behind a doubled UTF-8 byte order mark', () => {
    const odd = Buffer.concat([
      Buffer.from([0x07]),
      Buffer.from('qzx rest', 'utf16le'),
      Buffer.from([0, 0]),
    ])
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    const result = probe(['^qzx'], {
      'odd-le.bin': odd,
      'odd-be.bin': Buffer.concat([
        Buffer.from([0x07]),
        Buffer.from('qzx rest', 'utf16le').swap16(),
      ]),
      'double-bom.txt': Buffer.concat([bom, bom, Buffer.from('qzx\nx\n')]),
      'none.bin': Buffer.from([0x07, 0x00, 0x01]),
    })
    expect(result.hit).toEqual(['double-bom.txt', 'odd-be.bin', 'odd-le.bin'])
  })

  it('matches BOM-prefixed UTF-16 text that has no zero byte', () => {
    // U+0101 U+0115 U+0159 U+0105: every byte of the UTF-16 text is non-zero
    const text = Buffer.from('\u0101\u0115\u0159\u0105', 'utf16le')
    const result = probe(['\u0101\u0115\u0159\u0105'], {
      'bom-le.bin': Buffer.concat([Buffer.from([0xff, 0xfe]), text]),
      'bom-be.bin': Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text).swap16()]),
      'no-bom.bin': Buffer.from(text),
    })
    expect(result.hit).toEqual(['bom-be.bin', 'bom-le.bin'])
  })

  it('finds a name that starts with an accented capital with Unicode word edges', () => {
    const accents = new FixtureRepo('accent-edge-trunk')
    try {
      const sha = accents.commit('chore: start', {
        '.gitignore': '.keys/\n',
        'docs/inside.md': 'longer word: x\u00C9zebra and \u00C9zebrax\n',
        'docs/found.md': 'the name \u00C9zebra here\n',
      })
      accents.keys({ denylist: [`${EDGE_L}\u00E9zebra${EDGE_R}`] })
      const result = scan(accents)
      expect(result.status).toBe(1)
      const found = accents.pathNumber(sha, 'docs/found.md')
      expect(hitLines(result)).toEqual([`HIT content commit=${sha} path#=${found} pattern#=1`])
    } finally {
      accents.cleanup()
    }
  })

  it('matches UTF-16 files (with or without a byte order mark) and a UTF-8 BOM first line', () => {
    const wide = new FixtureRepo('wide-trunk')
    try {
      const le = Buffer.from('hello qzx\r\n', 'utf16le')
      const sha = wide.commit('chore: start', {
        '.gitignore': '.keys/\n',
        'data/bom-le.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), le]),
        'data/plain-le.txt': le,
        'data/plain-be.txt': Buffer.from(le).swap16(),
        'data/bom-be.txt': Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(le).swap16()]),
        'data/utf8-bom.txt': Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          Buffer.from('qzx\nx\n'),
        ]),
        'data/none.txt': 'nothing here\n',
      })
      wide.keys({ denylist: ['qzx', '^qzx$'] })
      const result = scan(wide)
      expect(result.status).toBe(1)
      const at = (path: string, pattern: number) =>
        `HIT content commit=${sha} path#=${wide.pathNumber(sha, path)} pattern#=${pattern}`
      expect(hitLines(result).sort()).toEqual(
        [
          at('data/bom-be.txt', 1),
          at('data/bom-le.txt', 1),
          at('data/plain-be.txt', 1),
          at('data/plain-le.txt', 1),
          at('data/utf8-bom.txt', 1),
          at('data/utf8-bom.txt', 2),
        ].sort(),
      )
    } finally {
      wide.cleanup()
    }
  })

  it('exits 2 when a ref points to a tree', () => {
    solo.updateRef('refs/tags/kilo-tree', solo.git('rev-parse', `${soloSha}^{tree}`))
    try {
      const result = scan(solo)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe('scan-repo: ref#2 does not point to a commit\n')
    } finally {
      solo.git('update-ref', '-d', 'refs/tags/kilo-tree')
    }
  })

  it('matches ^ and $ at each line end (flag m)', () => {
    // docs/solo.md is "qzx\n": without m, $ would only match at the very end, after the \n
    solo.keys({ denylist: ['^qzx$'] })
    const result = scan(solo)
    expect(result.status).toBe(1)
    expect(hitLines(result)).toEqual([`HIT ${soloHit().replace('pattern#=2', 'pattern#=1')}`])
  })

  it('matches a non-ASCII pattern case-insensitively across Unicode normal forms', () => {
    const accents = new FixtureRepo('accent-trunk')
    try {
      // content written decomposed (E + U+0301) and upper case; the pattern composed, lower case
      const sha = accents.commit('chore: start', {
        '.gitignore': '.keys/\n',
        'docs/accent.md': 'ZE\u0301BRANAME in decomposed form\n',
      })
      accents.keys({ denylist: ['zébraname'] })
      const result = scan(accents)
      expect(result.status).toBe(1)
      const number = accents.pathNumber(sha, 'docs/accent.md')
      expect(hitLines(result)).toEqual([`HIT content commit=${sha} path#=${number} pattern#=1`])
    } finally {
      accents.cleanup()
    }
  })

  it('peels a chain of annotated tags down to the commit', () => {
    const chain = new FixtureRepo('chain-trunk')
    try {
      const sha = chain.commit('chore: start', {
        '.gitignore': '.keys/\n',
        'docs/clean.md': 'clean\n',
      })
      chain.tag('indigo-inner', sha, 'inner notes mention qzx')
      chain.tag('indigo-outer', 'indigo-inner', 'outer notes')
      chain.git('tag', '-d', 'indigo-inner')
      chain.keys({ denylist: DENYLIST })
      const result = scan(chain)
      expect(result.status).toBe(1)
      expect(result.stdout).toBe(
        [
          'scan-repo: 2 refs, 1 commits, 2 blobs, 2 paths, 3 patterns',
          'HIT tag ref#=2 field=annotation pattern#=2',
          'result: 1 hits (0 accepted)',
          '',
        ].join('\n'),
      )
    } finally {
      chain.cleanup()
    }
  })

  it('ignores git replace objects, as push does', () => {
    const blob = solo.git('rev-parse', `${soloSha}:docs/solo.md`)
    const file = join(solo.root, 'replacement.txt')
    writeFileSync(file, 'nothing\n')
    solo.git('replace', blob, solo.git('hash-object', '-w', file))
    try {
      const result = scan(solo)
      expect(result.status).toBe(1)
      expect(hitLines(result)).toEqual([`HIT ${soloHit()}`])
    } finally {
      solo.git('replace', '-d', blob)
    }
  })

  it('exits 2 on a commit with a mergetag header, which it does not scan', () => {
    const who = `${identity(PROJECT)} 1793527200 +0000`
    const object = [
      `tree ${solo.git('rev-parse', `${soloSha}^{tree}`)}`,
      `parent ${soloSha}`,
      `author ${who}`,
      `committer ${who}`,
      `mergetag object ${soloSha}`,
      ' type commit',
      ' tag juliet-signed',
      ` tagger ${who}`,
      ' ',
      ' a signed tag',
      '',
      'merge: a signed tag',
      '',
    ].join('\n')
    const file = join(solo.root, 'mergetag-commit.txt')
    writeFileSync(file, object)
    const sha = solo.git('hash-object', '-t', 'commit', '-w', file)
    solo.updateRef('refs/heads/juliet-merge', sha)
    try {
      const result = scan(solo)
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toBe(
        `scan-repo: commit ${sha} has a mergetag header, which scan-repo does not scan\n`,
      )
    } finally {
      solo.git('update-ref', '-d', 'refs/heads/juliet-merge')
    }
  })

  it('matches the text inside a gzip blob, and exits 2 on one that does not inflate', () => {
    const packed = new FixtureRepo('gzip-trunk')
    try {
      const sha = packed.commit('chore: start', {
        '.gitignore': '.keys/\n',
        'data/feed.ndjson.gz': gzipSync('{"note":"qzx"}\n'),
      })
      packed.keys({ denylist: DENYLIST })
      const result = scan(packed)
      expect(result.status).toBe(1)
      const number = packed.pathNumber(sha, 'data/feed.ndjson.gz')
      expect(hitLines(result)).toEqual([`HIT content commit=${sha} path#=${number} pattern#=2`])
      packed.commit('chore: a broken archive', {
        'data/broken.gz': Uint8Array.of(0x1f, 0x8b, 0, 1),
      })
      const broken = scan(packed)
      expect(broken.status).toBe(2)
      expect(broken.stderr).toBe('scan-repo: a gzip blob could not be inflated\n')
    } finally {
      packed.cleanup()
    }
  })

  it('scans --repo even when GIT_DIR points at another repository', () => {
    const result = scan(clean, [], { GIT_DIR: join(solo.dir, '.git') })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('result: 0 hits (0 accepted)')
  })
})
