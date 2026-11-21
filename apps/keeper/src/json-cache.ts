// The ESPN day cache of `scripts/elo-build.ts`. A file goes to a temporary name first and is
// renamed over the target, so a stopped run never leaves half a day; a file that does not parse
// anyway (an older run, a disk error) is a cache miss, and that day is fetched again.
import { readFile, rename, rm, writeFile } from 'node:fs/promises'

/** The parsed JSON in `file`, or null when the file is missing or does not parse. */
export async function readJsonCache(file: string): Promise<unknown> {
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** Writes `data` to `file` through a temporary file in the same directory and a rename. */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  try {
    await writeFile(tmp, data)
    await rename(tmp, file)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
