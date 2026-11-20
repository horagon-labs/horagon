import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pruneArchive } from '../src/archive-retention'

/** 2026-11-24 12:00 in New York: the current ET date is 2026-11-24. */
const NOW = Date.parse('2026-11-24T17:00:00Z') / 1000
const line = (n: number) => `${JSON.stringify({ t: n, src: 'espn-scoreboard', body: {} })}\n`

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'horagon-archive-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const names = async () => (await readdir(dir)).sort()

describe('pruneArchive', () => {
  it('gzips game dates 2+ days old and deletes archives over 30 days old', async () => {
    await writeFile(join(dir, '2026-11-24.ndjson'), line(1))
    // After midnight ET late games still append to the previous date: left alone.
    await writeFile(join(dir, '2026-11-23.ndjson'), line(2))
    await writeFile(join(dir, '2026-11-22.ndjson'), line(3) + line(4))
    await writeFile(join(dir, '2026-11-14.ndjson.gz'), 'kept')
    await writeFile(join(dir, '2026-10-25.ndjson.gz'), '30 days: kept')
    await writeFile(join(dir, '2026-10-24.ndjson.gz'), '31 days: deleted')
    await writeFile(join(dir, 'notes.txt'), 'not an archive')

    expect(await pruneArchive(dir, NOW)).toEqual({
      gzipped: ['2026-11-22.ndjson'],
      deleted: ['2026-10-24.ndjson.gz'],
    })
    expect(await names()).toEqual([
      '2026-10-25.ndjson.gz',
      '2026-11-14.ndjson.gz',
      '2026-11-22.ndjson.gz',
      '2026-11-23.ndjson',
      '2026-11-24.ndjson',
      'notes.txt',
    ])
    const gz = await readFile(join(dir, '2026-11-22.ndjson.gz'))
    expect(gunzipSync(gz).toString('utf8')).toBe(line(3) + line(4))

    // A second run finds nothing to do.
    expect(await pruneArchive(dir, NOW)).toEqual({ gzipped: [], deleted: [] })
  })

  it('overwrites a leftover .gz.tmp and redoes a gzip cut short before the unlink', async () => {
    await writeFile(join(dir, '2026-11-20.ndjson'), line(5))
    await writeFile(join(dir, '2026-11-20.ndjson.gz.tmp'), 'partial garbage from a crash')
    await writeFile(join(dir, '2026-11-21.ndjson'), line(6))
    await writeFile(join(dir, '2026-11-21.ndjson.gz'), 'renamed, but the original survived')

    expect((await pruneArchive(dir, NOW)).gzipped).toEqual([
      '2026-11-20.ndjson',
      '2026-11-21.ndjson',
    ])
    expect(await names()).toEqual(['2026-11-20.ndjson.gz', '2026-11-21.ndjson.gz'])
    for (const [name, text] of [
      ['2026-11-20.ndjson.gz', line(5)],
      ['2026-11-21.ndjson.gz', line(6)],
    ] as const) {
      expect(gunzipSync(await readFile(join(dir, name))).toString('utf8'), name).toBe(text)
    }
  })

  it('gzips an old raw file first; the next run deletes it', async () => {
    await writeFile(join(dir, '2026-09-01.ndjson'), line(7))
    expect(await pruneArchive(dir, NOW)).toEqual({ gzipped: ['2026-09-01.ndjson'], deleted: [] })
    expect(await pruneArchive(dir, NOW)).toEqual({
      gzipped: [],
      deleted: ['2026-09-01.ndjson.gz'],
    })
    expect(await names()).toEqual([])
  })

  it('does nothing when the archive was never written, but fails on any other read error', async () => {
    expect(await pruneArchive(join(dir, 'missing'), NOW)).toEqual({ gzipped: [], deleted: [] })
    await writeFile(join(dir, 'a-file'), 'not a directory')
    await expect(pruneArchive(join(dir, 'a-file'), NOW)).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
  })

  it('ignores names that are not real game dates', async () => {
    await writeFile(join(dir, '2026-13-45.ndjson'), line(8))
    await writeFile(join(dir, '2026-11-01.ndjson.bak'), line(9))
    expect(await pruneArchive(dir, NOW)).toEqual({ gzipped: [], deleted: [] })
  })
})
