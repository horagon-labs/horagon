// Builds throwaway git repositories for the scan-repo tests. Every git call runs with an empty
// global and system config and explicit fake identities; nothing here is a real name, place,
// address or local offset.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SCRIPT = fileURLToPath(new URL('../../../../scripts/scan-repo.mjs', import.meta.url))

export interface Person {
  name: string
  email: string
  offset: string
}

export const PROJECT: Person = {
  name: 'Fixture Project',
  email: 'project@noreply.test',
  offset: '+0000',
}
export const QUILL: Person = {
  name: 'Zebraname Quill',
  email: 'fake@example.test',
  offset: '+0200',
}
export const NOBODY: Person = { name: 'Nobody Listed', email: 'nobody@other.test', offset: '+0000' }

export const identity = (person: Person): string => `${person.name} <${person.email}>`

export interface ScanResult {
  status: number | null
  stdout: string
  stderr: string
}

function isolatedEnv(config: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value
  }
  return { ...env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config, GIT_CONFIG_NOSYSTEM: '1' }
}

export class FixtureRepo {
  readonly root = mkdtempSync(join(tmpdir(), 'scanfix-'))
  readonly dir = join(this.root, 'work')
  readonly env: NodeJS.ProcessEnv
  readonly paths = new Set<string>()
  readonly refNames = new Set<string>()
  private clock = 0

  constructor(branch: string) {
    const config = join(this.root, 'empty.gitconfig')
    writeFileSync(config, '')
    this.env = isolatedEnv(config)
    mkdirSync(this.dir)
    this.git('init', '-q', '-b', branch)
    this.refNames.add(branch)
  }

  git(...args: string[]): string {
    return this.gitAs(this.env, args)
  }

  private gitAs(env: NodeJS.ProcessEnv, args: string[], cwd = this.dir): string {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
    return result.stdout.trim()
  }

  // Each commit or tag gets the next minute, written with the person's own offset.
  private people(author: Person, committer: Person): NodeJS.ProcessEnv {
    this.clock += 1
    const minute = String(this.clock % 60).padStart(2, '0')
    const hour = String(10 + Math.floor(this.clock / 60)).padStart(2, '0')
    const at = (person: Person) => `2026-11-01T${hour}:${minute}:00${person.offset}`
    return {
      ...this.env,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: at(author),
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
      GIT_COMMITTER_DATE: at(committer),
    }
  }

  addOrigin(): void {
    const origin = join(this.root, 'origin.git')
    mkdirSync(origin)
    this.gitAs(this.env, ['init', '-q', '--bare'], origin)
    this.git('remote', 'add', 'origin', '../origin.git')
    this.refNames.add('origin')
    this.refNames.add('refs/remotes/origin/HEAD')
  }

  write(files: Record<string, string | Uint8Array>): void {
    for (const [path, content] of Object.entries(files)) {
      const full = join(this.dir, path)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
      this.paths.add(path)
    }
  }

  commit(
    message: string,
    files: Record<string, string | Uint8Array>,
    who: { author?: Person; committer?: Person } = {},
  ): string {
    this.write(files)
    this.git('add', '-A')
    const env = this.people(who.author ?? PROJECT, who.committer ?? PROJECT)
    this.gitAs(env, ['commit', '-q', '--allow-empty', '-m', message])
    return this.git('rev-parse', 'HEAD')
  }

  merge(branch: string, message: string, files: Record<string, string>): string {
    this.gitAs(this.people(PROJECT, PROJECT), ['merge', '-q', '--no-ff', '--no-commit', branch])
    return this.commit(message, files)
  }

  branch(name: string, start: string): void {
    this.git('checkout', '-q', '-b', name, start)
    this.refNames.add(name)
  }

  checkout(name: string): void {
    this.git('checkout', '-q', name)
  }

  // Annotated when a message is given (the tagger is the committer identity), else lightweight.
  tag(name: string, target: string, message?: string, tagger: Person = PROJECT): void {
    const args = message === undefined ? [name, target] : ['-a', name, '-m', message, target]
    this.gitAs(this.people(tagger, tagger), ['tag', ...args])
    this.refNames.add(name)
  }

  updateRef(name: string, target: string): void {
    this.git('update-ref', name, target)
    this.refNames.add(name)
  }

  // denylist / accepted: lines joined with \n, a raw string as is, null removes the file.
  keys(files: { denylist?: string[] | string | null; accepted?: string[] | string | null }): void {
    const keysDir = join(this.dir, '.keys')
    mkdirSync(keysDir, { recursive: true })
    for (const [name, content] of [
      ['scan-denylist.txt', files.denylist],
      ['scan-accepted.txt', files.accepted],
    ] as const) {
      if (content === undefined) continue
      const file = join(keysDir, name)
      if (content === null) rmSync(file, { force: true })
      else writeFileSync(file, Array.isArray(content) ? `${content.join('\n')}\n` : content)
    }
  }

  // 1-based index of a path in `git ls-tree -r --name-only <commit>`: what path#= means.
  pathNumber(commit: string, path: string): number {
    const names = this.git('ls-tree', '-r', '-z', '--name-only', commit).split('\0')
    const index = names.indexOf(path)
    if (index === -1) throw new Error(`${path} is not in ${commit}`)
    return index + 1
  }

  scan(args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}): ScanResult {
    const result = spawnSync(process.execPath, [SCRIPT, '--repo', this.dir, ...args], {
      env: { ...this.env, ...extraEnv },
      encoding: 'utf8',
    })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  // Strings from this repository that must never reach the scan output.
  secrets(): string[] {
    const people = [PROJECT, QUILL, NOBODY].flatMap((p) => [p.name, p.email, identity(p)])
    const root = [this.root, this.root.replaceAll('\\', '/')]
    return [...this.paths, ...this.refNames, ...people, ...root]
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true, maxRetries: 3 })
  }
}

// What the output leaks: any secret (case-insensitive), any matched text, any offset value.
export function leaks(repo: FixtureRepo, result: ScanResult, matched: readonly string[]): string[] {
  const output = `${result.stdout}\n${result.stderr}`
  const lower = output.toLowerCase()
  const found = [...repo.secrets(), ...matched].filter((s) => lower.includes(s.toLowerCase()))
  return [...found, ...(output.match(/[+-]\d{4}\b/g) ?? [])]
}

export interface MainCommits {
  c1: string
  c2: string
  c3: string
  c4: string
  c5: string
  b1: string
  c6: string
  merge: string
  c7: string
  c8: string
  wip: string
  skipped: string
  light: string
  original: string
  mirror: string
}

// The main fixture. Refs in scope by default, in refname order:
//   1 refs/heads/alpha-trunk        7 refs/remotes/origin/bravo-pushed
//   2 refs/heads/bravo-pushed       8 refs/remotes/origin/qzx-echo
//   3 refs/heads/cobalt-wip         9 refs/tags/foxtrot-annotated
//   4 refs/heads/delta-skipme      10 refs/tags/golf-qzx-light
//   5 refs/heads/qzx-echo          11 refs/tags/hotel-renamed (its tag object says qzx-inner)
//   6 refs/remotes/origin/alpha-trunk
// refs/remotes/origin/HEAD, refs/remotes/hotel-remote/*, refs/original/*, refs/stash and
// refs/notes/* exist but are out of scope. cobalt-wip and delta-skipme are never pushed.
export function buildMainFixture(): { repo: FixtureRepo; commits: MainCommits } {
  const repo = new FixtureRepo('alpha-trunk')
  repo.addOrigin()
  const c1 = repo.commit('chore: start', {
    '.gitignore': '.keys/\n',
    'docs/clean.md': 'nothing to see\n',
    'src/carry.txt': 'token qzx here\n',
    'src/prefix.txt': 'PREQZX and QZXPOST\n',
  })
  const c2 = repo.commit('docs: add a plain file', {
    'docs/clean.md': 'still clean\n',
    'zebraname-dir/plain é.txt': 'plain words\n',
    'src/copy.txt': 'token qzx here\n',
  })
  const c3 = repo.commit('docs: a note about Qzx', { 'docs/note.md': 'a note\n' })
  const c4 = repo.commit('docs: quill file', { 'docs/quill.md': 'quill file\n' }, { author: QUILL })
  const c5 = repo.commit(
    'docs: nobody file',
    { 'docs/nobody.md': 'nobody file\n' },
    { author: NOBODY, committer: { ...PROJECT, offset: '+0200' } },
  )
  repo.branch('bravo-pushed', c5)
  const b1 = repo.commit('docs: bravo', { 'docs/bravo.md': 'bravo mentions zebraname\n' })
  repo.checkout('alpha-trunk')
  const c6 = repo.commit(
    'docs: trunk side',
    { 'docs/clean.md': 'trunk side mentions qzx\n' },
    { committer: { ...QUILL, offset: '+0000' } },
  )
  const merge = repo.merge('bravo-pushed', 'merge: bravo', {
    'docs/merge-only.md': 'merge says QZX\n',
  })
  const c7 = repo.commit('chore: clean the carry file', {
    'src/carry.txt': 'clean now\n',
    'zebraname-dir/plain é.txt': 'plain words, edited\n',
  })
  const c8 = repo.commit('revert: restore the carry file', { 'src/carry.txt': 'token qzx here\n' })
  repo.git('branch', 'qzx-echo', c1)
  repo.refNames.add('qzx-echo')
  repo.git('push', '-q', 'origin', 'alpha-trunk', 'bravo-pushed', 'qzx-echo')
  repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/alpha-trunk')
  repo.branch('cobalt-wip', c8)
  const wip = repo.commit(
    'wip: notes',
    { 'notes/wip.txt': 'ZEBRANAME in caps\n' },
    { author: { ...PROJECT, offset: '+0200' } },
  )
  repo.branch('delta-skipme', c1)
  const skipped = repo.commit('wip: skipped notes', { 'notes/skip.txt': 'skip qzx\n' })
  repo.tag('foxtrot-annotated', c3, 'release notes mention qzx', QUILL)
  repo.branch('tmp-light', c1)
  const light = repo.commit('chore: light', { 'notes/light.txt': 'light qzx\n' })
  repo.tag('golf-qzx-light', light)
  repo.tag('qzx-inner', c1, 'renamed tag')
  repo.updateRef('refs/tags/hotel-renamed', 'refs/tags/qzx-inner')
  repo.git('tag', '-d', 'qzx-inner')
  repo.refNames.add('hotel-renamed')
  repo.branch('tmp-original', c1)
  const original = repo.commit(
    'qzx original',
    { 'notes/original.txt': 'zebraname original\n' },
    { author: QUILL },
  )
  repo.updateRef('refs/original/refs/heads/alpha-trunk', original)
  repo.updateRef('refs/stash', original)
  repo.updateRef('refs/notes/commits', original)
  repo.branch('tmp-mirror', c1)
  const mirror = repo.commit('chore: mirror', { 'notes/mirror.txt': 'mirror qzx\n' })
  repo.updateRef('refs/remotes/hotel-remote/kilo-mirror', mirror)
  repo.refNames.add('hotel-remote')
  repo.refNames.add('kilo-mirror')
  repo.checkout('alpha-trunk')
  repo.git('branch', '-q', '-D', 'tmp-light', 'tmp-original', 'tmp-mirror')
  const commits = { c1, c2, c3, c4, c5, b1, c6, merge, c7, c8, wip, skipped, light }
  return { repo, commits: { ...commits, original, mirror } }
}
