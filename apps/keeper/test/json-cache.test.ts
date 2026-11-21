import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJsonCache, writeFileAtomic } from '../src/json-cache'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'horagon-cache-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readJsonCache', () => {
  it('returns the parsed day, or null for a missing or unparseable file (a miss)', async () => {
    const file = join(dir, '2026-11-18.json')
    expect(await readJsonCache(file)).toBeNull()
    // A run stopped mid-write left half a day behind.
    await writeFile(file, '{"events":[{"id":"401910007","season":')
    expect(await readJsonCache(file)).toBeNull()
    await writeFile(file, '')
    expect(await readJsonCache(file)).toBeNull()
    await writeFile(file, '{"events":[]}')
    expect(await readJsonCache(file)).toEqual({ events: [] })
  })
})

describe('writeFileAtomic', () => {
  it('writes through a temporary file, replaces an existing one, and leaves nothing else', async () => {
    const file = join(dir, '2026-11-18.json')
    await writeFileAtomic(file, '{"events":[1]}')
    expect(await readFile(file, 'utf8')).toBe('{"events":[1]}')
    await writeFile(file, '{"events":[')
    await writeFileAtomic(file, '{"events":[2]}')
    expect(await readJsonCache(file)).toEqual({ events: [2] })
    expect(await readdir(dir)).toEqual(['2026-11-18.json'])
  })

  it('removes its temporary file when the rename fails', async () => {
    // A directory where the file should go: the temporary write works, the rename cannot.
    const taken = join(dir, 'taken.json')
    await mkdir(taken)
    await expect(writeFileAtomic(taken, '{}')).rejects.toThrow()
    expect(await readdir(dir)).toEqual(['taken.json'])
  })
})
