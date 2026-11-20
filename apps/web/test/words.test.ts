import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const LIB = join(import.meta.dirname, '..', 'lib')

describe('product words (R4)', () => {
  it('keeps betting words out of every lib source', () => {
    const files = readdirSync(LIB).filter((f) => /\.tsx?$/.test(f))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(join(LIB, file), 'utf8')
      expect(text, file).not.toMatch(/\b(bet|bets|betting|wager\w*|odds|gambl\w*)\b/i)
    }
  })
})
