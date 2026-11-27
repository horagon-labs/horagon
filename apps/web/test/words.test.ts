import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const WEB = join(import.meta.dirname, '..')
/** Folders whose sources can put words on screen (R3), Chronometer ones by name (spec 2.7). */
const SOURCES = ['lib', 'components', 'app', 'lib/chrono', 'components/chrono']

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

  it.each(SOURCES)('keeps betting words out of every %s source, subfolders included', (dir) => {
    const root = join(WEB, dir)
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) =>
      /\.(tsx?|css|mjs)$/.test(f),
    )
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const hits = words(readFileSync(join(root, file), 'utf8')).filter(banned)
      expect(hits, `${dir}/${file}`).toEqual([])
    }
  })
})

/**
 * The culture review's refusal list (§4.1, A1): value words, tout words and luck words never appear
 * in a product string. Whole words, any case, so "between", "clock" and "unlocked" pass.
 */
const REFUSED: Array<[string, RegExp]> = [
  ['value: jackpot', /\bjackpots?\b/i],
  ['value: payout', /\bpay-?outs?\b/i],
  ['value: cash out', /\bcash(?:es|ed|ing)?[\s-]?outs?\b/i],
  ['value: profit', /\bprofit(?:s|able)?\b/i],
  ['value: earn', /\bearn(?:s|ed|ing|ings)?\b/i],
  ['value: reward', /\breward(?:s|ed|ing)?\b/i],
  ['tout: lock', /\blocks?\b/i],
  ['tout: sure thing', /\bsure[\s-]thing\b/i],
  ['tout: smart money', /\bsmart[\s-]money\b/i],
  ['tout: sharp', /\bsharps?\b/i],
  ['tout: due', /\bdue\b/i],
  ['tout: hot hand', /\bhot[\s-]hand\b/i],
  ['luck: lucky', /\blucky\b/i],
  ['luck: jinx', /\bjinx(?:es|ed)?\b/i],
]

/** The legal lines stay verbatim wherever they are, whatever they say (culture review §4.1). */
const LEGAL = [/No real value\. No prizes\./, /No value, no prizes\./, /I am 18 or older/]

/**
 * The text a source can put on screen: string and template literals and JSX text, never comments
 * or code. Import paths and `'use client'` are left out.
 */
function productStrings(file: string, text: string): string[] {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression)) return
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push(node.text)
    } else if (ts.isJsxText(node)) {
      const t = node.text.trim()
      if (t) out.push(t)
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out.filter((s) => !LEGAL.some((l) => l.test(s)))
}

/** A product string that shouts: a "!" after a word, not code such as `!==` inside a string. */
const SHOUTS = /[A-Za-z0-9.)'"]!(?=\s|$|['"`<])/

const productFiles = (dir: string) =>
  readdirSync(join(WEB, dir), { recursive: true, encoding: 'utf8' }).filter((f) =>
    /\.tsx?$/.test(f),
  )

describe('the timekeeper’s words (culture review A1)', () => {
  it('reads product strings only, and catches whole words in any case', () => {
    const strings = productStrings(
      'x.tsx',
      `// lock the clock
      const a = 'Jackpot tonight'
      const b = \`Cash out \${n} now!\`
      const c = <p>Smart money is due</p>
      import x from './lock'`,
    )
    expect(strings).toEqual(['Jackpot tonight', 'Cash out ', ' now!', 'Smart money is due'])
    const hits = (s: string) => REFUSED.filter(([, re]) => re.test(s)).map(([n]) => n)
    expect(hits('Jackpot tonight')).toEqual(['value: jackpot'])
    expect(hits('Smart money is due')).toEqual(['tout: smart money', 'tout: due'])
    for (const fine of ['between', 'the clock', 'unlocked', 'learn', 'sharpen', 'overdue']) {
      expect(hits(fine), fine).toEqual([])
    }
    expect(SHOUTS.test(' now!')).toBe(true)
    expect(SHOUTS.test('a !== b')).toBe(false)
    expect(
      productStrings('x.tsx', `const l = 'Play-money on devnet. No real value. No prizes.'`),
    ).toEqual([])
  })

  it.each(SOURCES)('keeps value, tout and luck words and "!" out of %s product strings', (dir) => {
    for (const file of productFiles(dir)) {
      const strings = productStrings(file, readFileSync(join(WEB, dir, file), 'utf8'))
      const refused = strings.flatMap((s) =>
        REFUSED.filter(([, re]) => re.test(s)).map(([n]) => `${n} in "${s}"`),
      )
      expect(refused, `${dir}/${file}`).toEqual([])
      expect(
        strings.filter((s) => SHOUTS.test(s)),
        `${dir}/${file}`,
      ).toEqual([])
    }
  })
})
