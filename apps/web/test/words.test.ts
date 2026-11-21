import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const LIB = join(import.meta.dirname, '..', 'lib')

const FORBIDDEN = ['bet', 'bets', 'betting', 'betslip', 'odds']
const FORBIDDEN_PREFIX = ['gambl', 'wager']

/** Splits camelCase and snake_case identifiers and prose into lowercase words. */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)
}

const banned = (word: string) =>
  FORBIDDEN.includes(word) || FORBIDDEN_PREFIX.some((p) => word.startsWith(p))

describe('product words (R4)', () => {
  it('catches camelCase identifiers and compounds, but not innocent words', () => {
    for (const bad of ['placeBet', 'BetButton', 'betslip', 'the odds', 'Wagering', 'gambling']) {
      expect(words(bad).some(banned), bad).toBe(true)
    }
    for (const fine of ['alphabet', 'better', 'between', 'Bethany', 'modelProb']) {
      expect(words(fine).some(banned), fine).toBe(false)
    }
  })

  it('keeps betting words out of every lib source, subfolders included', () => {
    const files = readdirSync(LIB, { recursive: true, encoding: 'utf8' }).filter((f) =>
      /\.tsx?$/.test(f),
    )
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const hits = words(readFileSync(join(LIB, file), 'utf8')).filter(banned)
      expect(hits, file).toEqual([])
    }
  })
})
