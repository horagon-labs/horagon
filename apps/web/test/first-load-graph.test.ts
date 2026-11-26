// What a page load ships to the browser (R5c): every module the client bundle of `/` and
// `/game/[id]` reaches by a static import, from the app's own sources. A 'use client' module and
// everything it imports run in the browser; a dynamic import() is a chunk of its own, loaded on
// use. None of them may load web3.js: its signing code comes with the first wallet action.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const WEB = resolve(import.meta.dirname, '..')
const SDK = resolve(WEB, '..', '..', 'packages', 'sdk')

/** The SDK's entries (packages/sdk/tsup.config.ts), by import path. */
const SDK_ENTRIES: Record<string, string> = {
  '@horagon/sdk': 'src/index.ts',
  '@horagon/sdk/math': 'src/math/index.ts',
  '@horagon/sdk/evidence': 'src/evidence/index.ts',
  '@horagon/sdk/client': 'src/client/index.ts',
  '@horagon/sdk/errors': 'src/errors-entry.ts',
  '@horagon/sdk/amount': 'src/amount.ts',
  '@horagon/sdk/notice': 'src/notice.ts',
}

const ENTRIES = ['app/layout.tsx', 'app/page.tsx', 'app/game/[id]/page.tsx'].map((f) =>
  join(WEB, f),
)

interface Parsed {
  useClient: boolean
  /** Static imports and re-exports that are not `import type` / `export type`. */
  values: string[]
}

function parse(file: string): Parsed {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const first = src.statements[0]
  const useClient =
    first !== undefined &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === 'use client'
  const values: string[] = []
  for (const s of src.statements) {
    // `import { type A } from 'x'` still counts: verbatimModuleSyntax keeps it as `import {}`.
    if (ts.isImportDeclaration(s) && !s.importClause?.isTypeOnly) {
      values.push((s.moduleSpecifier as ts.StringLiteral).text)
    }
    if (ts.isExportDeclaration(s) && !s.isTypeOnly && s.moduleSpecifier) {
      values.push((s.moduleSpecifier as ts.StringLiteral).text)
    }
  }
  return { useClient, values }
}

function resolveLocal(from: string, spec: string): string | null {
  if (spec.startsWith('.')) {
    const base = resolve(dirname(from), spec.replace(/\.js$/, ''))
    for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      if (/\.tsx?$/.test(c) && existsSync(c)) return c
    }
    return null
  }
  const entry = SDK_ENTRIES[spec]
  return entry ? join(SDK, entry) : null
}

/** Every client module, with the bare specifiers it imports by value. */
function clientGraph() {
  const client = new Map<string, string[]>()
  const seen = new Set<string>()
  const visit = (file: string, parentClient: boolean) => {
    const parsed = parse(file)
    const isClient = parentClient || parsed.useClient
    const key = `${file}:${isClient}`
    if (seen.has(key) || (!isClient && seen.has(`${file}:true`))) return
    seen.add(key)
    if (isClient) client.set(file, parsed.values)
    for (const spec of parsed.values) {
      const next = resolveLocal(file, spec)
      if (next) visit(next, isClient)
    }
  }
  for (const e of ENTRIES) visit(e, false)
  return client
}

const graph = clientGraph()
const name = (file: string) => relative(resolve(WEB, '..', '..'), file).replaceAll('\\', '/')
const importers = (spec: string) =>
  [...graph].filter(([, values]) => values.includes(spec)).map(([file]) => name(file))

describe('the first load of / and /game/[id] has no web3.js (R5c)', () => {
  it('walks the real client graph: the wallet provider, its light store and the SDK client', () => {
    const files = [...graph.keys()].map(name)
    for (const f of [
      'apps/web/components/wallet.tsx',
      'apps/web/lib/wallet-loader.ts',
      'apps/web/lib/key-store.ts',
      'apps/web/components/tonight-board.tsx',
      'apps/web/components/game-view.tsx',
      'packages/sdk/src/client/index.ts',
    ]) {
      expect(files, f).toContain(f)
    }
  })

  it('no client module imports web3.js by value, in the app or in the SDK entries it uses', () => {
    expect(importers('@solana/web3.js')).toEqual([])
  })

  it('no client module imports the SDK index, which builds PublicKeys when it loads', () => {
    expect(importers('@horagon/sdk')).toEqual([])
  })

  it('the key code and the signer are reached only by a dynamic import()', () => {
    const files = [...graph.keys()].map(name)
    for (const lazy of ['burner.ts', 'wallet-core.ts', 'age-gate.ts', 'trade.ts', 'faucet.ts']) {
      expect(files, lazy).not.toContain(`apps/web/lib/${lazy}`)
    }
    const read = (f: string) => readFileSync(join(WEB, f), 'utf8')
    expect(read('lib/wallet-loader.ts')).toContain("import('./wallet-core')")
    expect(read('lib/use-trade.ts')).toContain("import('./trade')")
    expect(read('components/wallet.tsx')).toContain("import('../lib/trade')")
    expect(read('components/wallet.tsx')).toContain("import('../lib/faucet')")
  })

  it('the built SDK entries the pages use load no web3.js, chunks included', () => {
    const used = new Set([...graph.values()].flat().filter((s) => s.startsWith('@horagon/sdk/')))
    expect(used.size).toBeGreaterThan(0)
    for (const spec of used) {
      const start = join(SDK, 'dist', `${spec.slice('@horagon/sdk/'.length)}.js`)
      const files = [start]
      for (let i = 0; i < files.length; i++) {
        const text = readFileSync(files[i] as string, 'utf8')
        expect(text, `${spec}: ${name(files[i] as string)}`).not.toMatch(
          /['"]@solana\/web3\.js['"]/,
        )
        for (const m of text.matchAll(/(?:from|import)\s*["'](\.\/[^"']+)["']/g)) {
          const next = join(dirname(files[i] as string), m[1] as string)
          if (!files.includes(next)) files.push(next)
        }
      }
    }
  })
})
