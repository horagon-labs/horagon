// Retention of the raw ESPN archive (`RawArchive`: one `<gameDate>.ndjson` per US Eastern game
// date). Run hourly by the keeper: a game date 2 or more days before today (ET) is gzipped, since
// late games append to the previous date's file after midnight ET but never two days on; a
// `.ndjson.gz` whose game date is more than 30 days old is deleted.
import { createReadStream, createWriteStream } from 'node:fs'
import { readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { easternDate } from './feeds/types'

export const GZIP_AFTER_DAYS = 2
export const KEEP_DAYS = 30

const ARCHIVE_NAME = /^(\d{4}-\d{2}-\d{2})\.ndjson(\.gz)?$/
const DAY_MS = 86_400_000

/** Whole days from game date `from` to `to` (both YYYY-MM-DD); NaN for a date that is not real. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  if (Number.isNaN(a) || !new Date(a).toISOString().startsWith(from)) return Number.NaN
  return Math.round((Date.parse(`${to}T00:00:00Z`) - a) / DAY_MS)
}

/**
 * `<file>.gz` written atomically: `.gz.tmp` first (a leftover from a crash is overwritten),
 * renamed over any `.gz`, then the original removed. A crash before the removal leaves the
 * original, and the next run gzips it again.
 */
async function gzipFile(path: string): Promise<void> {
  const tmp = `${path}.gz.tmp`
  await pipeline(createReadStream(path), createGzip(), createWriteStream(tmp))
  await rename(tmp, `${path}.gz`)
  await rm(path)
}

/** One retention pass over `dir`; a missing directory (nothing archived yet) is not an error. */
export async function pruneArchive(
  dir: string,
  nowSecs: number,
): Promise<{ gzipped: string[]; deleted: string[] }> {
  const gzipped: string[] = []
  const deleted: string[] = []
  let names: string[]
  try {
    names = (await readdir(dir)).sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { gzipped, deleted }
    throw err
  }
  const today = easternDate(new Date(nowSecs * 1000))
  for (const name of names) {
    const m = ARCHIVE_NAME.exec(name)
    if (!m?.[1]) continue
    const age = daysBetween(m[1], today)
    if (!m[2] && age >= GZIP_AFTER_DAYS) {
      await gzipFile(join(dir, name))
      gzipped.push(name)
    } else if (m[2] && age > KEEP_DAYS) {
      await rm(join(dir, name))
      deleted.push(name)
    }
  }
  return { gzipped, deleted }
}
