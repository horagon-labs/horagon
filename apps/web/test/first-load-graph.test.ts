// What a page load ships to the browser (R5c): every module the client bundle of `/` and
// `/game/[id]` reaches by a static import, from the app's own sources. A 'use client' module and
// everything it imports run in the browser; a dynamic import() is a chunk of its own, loaded on
// use. None of them may load web3.js: its signing code comes with the first wallet action.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const WEB = resolve(import.meta.dirname, '..')
const PACKAGES = resolve(WEB, '..', '..', 'packages')
const SDK = join(PACKAGES, 'sdk')

/**
 * The SDK's entries by import path, with their sources, read from packages/sdk/tsup.config.ts so
 * a new entry is walked too: `index: 'src/index.ts'` is '@horagon/sdk'.
 */
const SDK_ENTRIES: Record<string, string> = Object.fromEntries(
  [
    ...readFileSync(join(SDK, 'tsup.config.ts'), 'utf8').matchAll(
      /^\s*'?([\w-]+)'?: '(src\/[^']+)'/gm,
    ),
  ].map(([, entry, src]) => [
    entry === 'index' ? '@horagon/sdk' : `@horagon/sdk/${entry}`,
    src as string,
  ]),
)

const ENTRIES = [
  'app/layout.tsx',
  'app/page.tsx',
  'app/game/[id]/page.tsx',
  'app/me/page.tsx',
  // R6 part B: /verify's checks pull in web3.js, so they load only once its view runs.
  'app/verify/[market]/page.tsx',
  // Every route's tree also holds the error boundary and the 404 (light branding review §4.12).
  'app/error.tsx',
  'app/not-found.tsx',
  'app/global-error.tsx',
].map((f) => join(WEB, f))

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

/** `base` as a source file: itself, with .ts or .tsx, or its index.ts. */
function sourceFile(base: string): string | null {
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (/\.tsx?$/.test(c) && existsSync(c)) return c
  }
  return null
}

/**
 * The file a workspace package exports for `spec` ('@horagon/api', '@horagon/sdk/client'), as
 * its package.json says (the ESM import), or null when it exports no such path.
 */
function workspaceExport(spec: string): string | null {
  const m = /^@horagon\/([^/]+)(\/.+)?$/.exec(spec)
  const dir = m ? join(PACKAGES, m[1] as string) : null
  if (!m || !dir || !existsSync(join(dir, 'package.json'))) return null
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const target = pkg.exports?.[m[2] ? `.${m[2]}` : '.']
  const file = typeof target === 'string' ? target : target?.import?.default
  return typeof file === 'string' ? join(dir, file) : null
}

/**
 * A source file to walk for `spec`: a relative path, the `@/*` alias of tsconfig.json, an SDK
 * entry (its source, SDK_ENTRIES), or another workspace package that exports its source. Null
 * otherwise: a bare package (react, zod), or a `@/` or `@horagon/` path that does not resolve,
 * which the graph lists as unresolved so the test fails rather than skip it.
 */
function resolveLocal(from: string, spec: string): string | null {
  if (spec.startsWith('.')) return sourceFile(resolve(dirname(from), spec.replace(/\.js$/, '')))
  if (spec.startsWith('@/')) return sourceFile(resolve(WEB, spec.slice(2).replace(/\.js$/, '')))
  if (spec === '@horagon/sdk' || spec.startsWith('@horagon/sdk/')) {
    const entry = SDK_ENTRIES[spec]
    return entry ? join(SDK, entry) : null
  }
  const exported = spec.startsWith('@horagon/') ? workspaceExport(spec) : null
  return exported && /\.tsx?$/.test(exported) ? exported : null
}

/** A specifier the walk must follow: the app's alias and the workspace packages. */
const mustResolve = (spec: string) => spec.startsWith('@/') || spec.startsWith('@horagon/')

/** Every client module, with the bare specifiers it imports by value. */
function clientGraph() {
  const client = new Map<string, string[]>()
  const unresolved: string[] = []
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
      // A stylesheet loads no script; any other miss would be a module the walk skipped.
      else if ((spec.startsWith('.') && !spec.endsWith('.css')) || mustResolve(spec)) {
        unresolved.push(`${file}: ${spec}`)
      }
    }
  }
  for (const e of ENTRIES) visit(e, false)
  return { client, unresolved }
}

const { client: graph, unresolved } = clientGraph()
const name = (file: string) => relative(resolve(WEB, '..', '..'), file).replaceAll('\\', '/')
const importers = (spec: string) =>
  [...graph].filter(([, values]) => values.includes(spec)).map(([file]) => name(file))

describe('the first load of / and /game/[id] has no web3.js (R5c)', () => {
  it('resolves every relative, @/ and @horagon/ import it meets, so none is skipped (R5c refix)', () => {
    expect(unresolved).toEqual([])
    // The resolver itself: the alias, an SDK entry, a workspace package's source, and the misses.
    const from = join(WEB, 'app', 'page.tsx')
    expect(resolveLocal(from, '@/lib/burner')).toBe(join(WEB, 'lib', 'burner.ts'))
    expect(resolveLocal(from, '@/components/wallet')).toBe(join(WEB, 'components', 'wallet.tsx'))
    expect(resolveLocal(from, '@horagon/sdk/client')).toBe(join(SDK, 'src/client/index.ts'))
    expect(resolveLocal(from, '@horagon/api')).toBe(join(PACKAGES, 'api', 'src', 'index.ts'))
    expect(resolveLocal(from, '@/lib/no-such-module')).toBeNull()
    expect(resolveLocal(from, '@horagon/sdk/no-such-entry')).toBeNull()
    expect(resolveLocal(from, '@horagon/no-such-package')).toBeNull()
    // SDK_ENTRIES (from tsup.config.ts) has every entry, each a real export of the SDK.
    expect(Object.keys(SDK_ENTRIES)).toEqual(
      expect.arrayContaining([
        '@horagon/sdk',
        '@horagon/sdk/client',
        '@horagon/sdk/notice',
        '@horagon/sdk/et',
      ]),
    )
    for (const spec of Object.keys(SDK_ENTRIES)) {
      expect(workspaceExport(spec), spec).toMatch(/dist[\\/][\w-]+\.js$/)
    }
  })

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

  it('/verify reaches its checks only by a dynamic import(), and / never reaches it (R6 part B)', () => {
    const files = [...graph.keys()].map(name)
    expect(files).toContain('apps/web/components/verify-view.tsx')
    expect(files).not.toContain('apps/web/lib/verify.ts')
    expect(readFileSync(join(WEB, 'components/verify-view.tsx'), 'utf8')).toContain(
      "import('../lib/verify')",
    )
    const home = new Set<string>()
    const walk = (file: string) => {
      if (home.has(file)) return
      home.add(file)
      for (const spec of parse(file).values) {
        const next = resolveLocal(file, spec)
        if (next) walk(next)
      }
    }
    walk(join(WEB, 'app/page.tsx'))
    walk(join(WEB, 'app/layout.tsx'))
    const reached = [...home].map(name)
    expect(reached).not.toContain('apps/web/components/verify-view.tsx')
    expect(reached).not.toContain('apps/web/lib/verify.ts')
  })

  it('motion’s animation features load after the first render, not with it (R5c refix)', () => {
    expect([...graph.keys()].map(name)).not.toContain('apps/web/lib/chrono/motion-features.ts')
    const motion = readFileSync(join(WEB, 'components', 'chrono', 'motion.tsx'), 'utf8')
    expect(motion).toContain("import('../../lib/chrono/motion-features')")
    expect(motion).not.toMatch(/\bdomAnimation\b/)
    const importers = [...graph].filter(([, values]) => values.includes('motion/react'))
    expect(importers.length).toBeGreaterThan(0)
    for (const [file] of importers) {
      expect(readFileSync(file, 'utf8'), name(file)).not.toMatch(/\bdom(Animation|Max)\b/)
    }
  })

  it('the built workspace entries the pages use load no web3.js, chunks included', () => {
    const used = new Set([...graph.values()].flat().filter((s) => s.startsWith('@horagon/')))
    expect(used.size).toBeGreaterThan(0)
    for (const spec of used) {
      // What the bundler loads: the package's own export, built (the SDK's dist) or source.
      const start = workspaceExport(spec)
      expect(start, spec).not.toBeNull()
      // A source export is part of the walk above, with every check there.
      if (start === null || /\.tsx?$/.test(start)) continue
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
