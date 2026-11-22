#!/usr/bin/env node
// Scans everything a push could publish against the patterns in .keys/scan-denylist.txt: every
// commit reachable from the refs in scope, each file content and path where a commit introduces
// it, commit messages, author and committer identities and offsets, ref names and annotated tags.
// It prints SHAs, counts and field names only, never the matched text, a path, a ref name, an
// identity or an offset. Needs Node 22 or later and git; nothing to install.
//
//   node scripts/scan-repo.mjs [--repo <dir>] [--remote <name>] [--skip <refname>]...
//                              [--identity "<Name> <email>"]...
//
// --repo defaults to the current directory; .keys/ is read at the top of its work tree.
//
// Denylist rules (.keys/scan-denylist.txt):
//   - The file is UTF-8 text; UTF-16, a NUL byte or invalid UTF-8 exits 2. Leading BOMs go.
//   - Each line is trimmed; a blank line or one starting with # is skipped. pattern#=<k> is the
//     1-based line number.
//   - Every line, comment lines included, is checked for invisible or control characters
//     (zero-width, soft hyphen, NBSP inside, tab, lone CR, NEL, U+2028, default-ignorable ones
//     such as U+FE0F or U+3164): one exits 2, because it would silently disable a pattern or hide
//     the text that follows it.
//   - Each pattern is a regex matched with flags i, m and u on Unicode NFC text. Before it is
//     compiled, \b \B \w \W are translated to Unicode-aware forms (letters, digits and _, written
//     \p{L}_\p{N}); \W or \b inside a [...] class exits 2; an identity escape such as \- or \@
//     keeps its literal meaning under the u flag. A range that touches \w (as in [\w-z] or
//     [a-\w]) is a regex error, so it exits 2; [\w-] and [-\w] are fine.
// Content rules: a blob is matched as UTF-8 and also as UTF-16LE/BE (when it has a UTF-16 BOM or
// a NUL byte, at both byte alignments), with leading BOMs dropped; a gzip blob is matched both
// raw and inflated. Commits, tags, tree entry names and ref names are read as strict UTF-8: bytes
// that are not valid UTF-8, or a commit or tag with a non-UTF-8 encoding header, exit 2 (the
// message names only a SHA, or nothing for a ref name).
//
// Scope: refs/remotes/<remote>/* (default origin) except HEAD, every refs/heads/* not named by
// --skip, and refs/tags/*; never refs/original/*, refs/stash or refs/notes/*. Refs are numbered
// 1..N in refname order and printed as ref#=<n>. A path is printed as path#=<n>, its 1-based line
// in `git ls-tree -r --name-only <sha>`. To map the numbers back to names, locally:
//   git ls-tree -r --full-tree --name-only <sha> | sed -n '<n>p'
//   git for-each-ref --sort=refname --format='%(refname)' refs/heads refs/remotes/origin refs/tags
//   (then drop refs/remotes/origin/HEAD and the --skip refs, and number the rest with nl)
//
// Hits on a commit listed in .keys/scan-accepted.txt print ACCEPTED instead of HIT; ref and tag
// hits are never accepted. Acceptance is per commit, so a pattern added later that hits an
// accepted commit prints ACCEPTED too: after any denylist change, re-read the ACCEPTED lines or
// empty scan-accepted.txt before trusting exit 0.
//
// scan-accepted.txt is also UTF-8 text, but its lines are not trimmed: a line that is not exactly
// a 40-hex SHA exits 2.
//
// Replacement objects (git replace) are ignored, as push ignores them. A commit with a mergetag
// header is a config error, because the tag it embeds is not scanned.
//
// Exit codes: 0 no unaccepted hit, 1 an unaccepted hit, 2 a usage or config error.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'

const USAGE =
  'usage: node scripts/scan-repo.mjs [--repo <dir>] [--remote <name>] [--skip <refname>]... [--identity "<Name> <email>"]...'
const DENYLIST = '.keys/scan-denylist.txt'
const ACCEPTED = '.keys/scan-accepted.txt'
const OBJECTS_PER_BATCH = 500
const MAX_OUTPUT = 1024 ** 3
// Inside a git hook these point git at a repository other than --repo, so they are dropped.
const REPO_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]

class ConfigError extends Error {}

// git replace would show the scan objects other than the ones a push sends, so it is turned off.
const gitEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !REPO_LOCATION_VARS.includes(key.toUpperCase())),
  ),
  GIT_NO_REPLACE_OBJECTS: '1',
}

// git's own stderr is captured and dropped: it can name refs or paths.
function run(cwd, args, input) {
  const result = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    env: gitEnv,
    input,
    maxBuffer: MAX_OUTPUT,
    windowsHide: true,
  })
  if (result.error) throw new ConfigError(`git ${args[0]} could not run (${result.error.code})`)
  return result
}

function git(cwd, args, input) {
  const result = run(cwd, args, input)
  if (result.status !== 0) {
    throw new ConfigError(`git ${args[0]} failed with exit code ${result.status}`)
  }
  return result.stdout
}

function parseArgs(argv) {
  const options = { repo: '.', remote: 'origin', skip: new Set(), identities: new Set() }
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1]
    if (value === undefined) throw new ConfigError(USAGE)
    switch (argv[i]) {
      case '--repo':
        options.repo = value
        break
      case '--remote':
        options.remote = value
        break
      case '--skip':
        options.skip.add(value.startsWith('refs/') ? value : `refs/heads/${value}`)
        break
      case '--identity':
        options.identities.add(value.trim())
        break
      default:
        throw new ConfigError(USAGE)
    }
  }
  return options
}

// Lines with their 1-based line numbers, minus blank lines and lines that start with #. With
// trim the line is trimmed first (the denylist); without it only a trailing \r is removed and a
// line of spaces still counts as blank (the accepted list, which must be exact).
// The file must be UTF-8 text: a UTF-16 file or one with a NUL byte or invalid UTF-8 is an error,
// since its patterns would silently never match. Leading byte order marks are removed.
function readLines(file, label, trim) {
  const bytes = readFileSync(file)
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)
  let raw = ''
  try {
    if (utf16 || bytes.includes(0)) throw new Error('not utf-8')
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new ConfigError(`${label} is not UTF-8 text`)
  }
  const lines = []
  for (const [index, line] of raw
    .replace(/^\uFEFF+/, '')
    .split('\n')
    .entries()) {
    const text = trim ? line.trim() : line.replace(/\r$/, '')
    // Checked on comment lines too: a lone CR, NEL or U+2028 inside a comment would hide the
    // text after it, which an editor shows as a pattern line of its own.
    if (trim && INVISIBLE.test(text)) {
      const what = text.startsWith('#') ? `${label} line ${index + 1}` : `pattern#${index + 1}`
      throw new ConfigError(`${what} contains an invisible or control character`)
    }
    if (text.trim() !== '' && !text.startsWith('#')) lines.push({ line: index + 1, text })
  }
  return lines
}

// Characters that survive trim() but are invisible or control characters: they would make a
// pattern silently never match. Only the plain space may appear inside a pattern.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]|(?! )\p{Zs}/u
// The underscore sits between the two property escapes, so that a range next to a translated \w
// (as in [\w-z]) has a class escape at its end, which is a SyntaxError under u: it fails closed.
const WORD = '\\p{L}_\\p{N}'
// Characters that may follow a backslash and keep their meaning under the u flag.
const SYNTAX = new Set('^$\\.*+?()[]{}|/')

// Rewrites the escapes that are ASCII-only (\b \B \w \W) or invalid under the u flag (identity
// escapes such as \- or \@) into forms that work on Unicode text. `inClass` tracks [...].
function translate(source, line) {
  const wrong = () => new ConfigError(`pattern#${line} uses \\W or \\b inside a character class`)
  let out = ''
  let inClass = false
  for (let i = 0; i < source.length; ) {
    const ch = String.fromCodePoint(source.codePointAt(i))
    i += ch.length
    if (ch !== '\\' || i >= source.length) {
      if (!inClass && ch === '[') inClass = true
      else if (inClass && ch === ']') inClass = false
      out += ch
      continue
    }
    const next = String.fromCodePoint(source.codePointAt(i))
    i += next.length
    if (next === 'b' || next === 'B' || next === 'W') {
      if (inClass) throw wrong()
      if (next === 'W') out += `[^${WORD}]`
      else if (next === 'b') {
        out += `(?:(?<=[${WORD}])(?![${WORD}])|(?<![${WORD}])(?=[${WORD}]))`
      } else out += `(?:(?<=[${WORD}])(?=[${WORD}])|(?<![${WORD}])(?![${WORD}]))`
    } else if (next === 'w') {
      out += inClass ? WORD : `[${WORD}]`
    } else if (/[A-Za-z0-9]/.test(next) || SYNTAX.has(next) || (inClass && next === '-')) {
      out += `\\${next}`
    } else {
      out += `\\u{${next.codePointAt(0).toString(16)}}`
    }
  }
  return out
}

function loadPatterns(root) {
  if (!existsSync(join(root, DENYLIST))) throw new ConfigError(`${DENYLIST} is missing`)
  const check = run(root, ['check-ignore', '-q', DENYLIST])
  if (check.status === 1) throw new ConfigError(`${DENYLIST} is not ignored by git`)
  if (check.status !== 0) throw new ConfigError('git check-ignore failed')
  const patterns = readLines(join(root, DENYLIST), DENYLIST, true).map(({ line, text }) => {
    try {
      return { id: line, regex: new RegExp(translate(text.normalize('NFC'), line), 'imu') }
    } catch (error) {
      if (error instanceof ConfigError) throw error
      throw new ConfigError(`pattern#${line} is not a valid regular expression (flags i, m, u)`)
    }
  })
  if (patterns.length === 0) throw new ConfigError(`${DENYLIST} has no patterns`)
  return patterns
}

function loadAccepted(root) {
  const accepted = new Set()
  if (!existsSync(join(root, ACCEPTED))) return accepted
  for (const { line, text } of readLines(join(root, ACCEPTED), ACCEPTED, false)) {
    if (!/^[0-9a-f]{40}$/i.test(text)) {
      throw new ConfigError(`${ACCEPTED} line ${line} is not a full 40-hex commit SHA`)
    }
    accepted.add(text.toLowerCase())
  }
  return accepted
}

// Ids of the patterns that match. Text and patterns are compared in Unicode NFC, so a decomposed
// letter (e + U+0301) matches a pattern typed with the composed one.
function matching(patterns, text) {
  const normalized = text.normalize('NFC')
  return patterns.filter((p) => p.regex.test(normalized)).map((p) => p.id)
}

// Streams objects through one `git cat-file --batch` per chunk: visit(oid, type, data).
function readObjects(root, oids, visit) {
  for (let start = 0; start < oids.length; start += OBJECTS_PER_BATCH) {
    const chunk = oids.slice(start, start + OBJECTS_PER_BATCH)
    const out = git(root, ['cat-file', '--batch'], `${chunk.join('\n')}\n`)
    let at = 0
    for (const oid of chunk) {
      const eol = out.indexOf(10, at)
      const [, type, size] = out.toString('latin1', at, eol).split(' ')
      if (size === undefined) throw new ConfigError('git cat-file reported a missing object')
      const end = eol + 1 + Number(size)
      visit(oid, type, out.subarray(eol + 1, end))
      at = end + 1
    }
  }
}

// The texts a blob is matched as: its decodings, plus those of the inflated bytes when it is gzip
// (1f 8b), so a name inside a compressed recording is still found.
function blobTexts(data) {
  const texts = decodings(data)
  if (data[0] === 0x1f && data[1] === 0x8b) {
    try {
      texts.push(...decodings(gunzipSync(data, { maxOutputLength: MAX_OUTPUT })))
    } catch {
      throw new ConfigError('a gzip blob could not be inflated')
    }
  }
  return texts
}

// UTF-8 always; when the blob has a UTF-16 BOM or a NUL byte, also UTF-16LE and BE at both
// alignments. Leading U+FEFF characters are dropped so that ^-anchored patterns see line 1.
function decodings(data) {
  const even = (bytes) => bytes.subarray(0, bytes.length - (bytes.length % 2))
  const le = (bytes) => even(bytes).toString('utf16le')
  const be = (bytes) => Buffer.from(even(bytes)).swap16().toString('utf16le')
  const texts = [data.toString('utf8')]
  const bom = (data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)
  if (bom || data.includes(0)) {
    // both byte orders at both alignments; the BOM, if any, is dropped below
    texts.push(le(data), be(data), le(data.subarray(1)), be(data.subarray(1)))
  }
  return texts.map((text) => text.replace(/^\uFEFF+/, ''))
}

function readObject(root, oid) {
  const objects = []
  readObjects(root, [oid], (_oid, type, data) => objects.push({ type, data }))
  return objects[0]
}

// Git objects are scanned as UTF-8, so bytes that are not valid UTF-8 would be decoded lossily and
// could hide a match: they are an error, naming only a SHA or nothing.
const STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// Splits the NUL-separated output of git into strings, decoded strictly. `fail(commit)` builds the
// error for a token that is not valid UTF-8; `commit` is the last 40-hex token seen before it.
function strictTokens(out, commit, fail) {
  const tokens = []
  for (let start = 0; start <= out.length; ) {
    let end = out.indexOf(0, start)
    if (end === -1) end = out.length
    let token = ''
    try {
      token = STRICT.decode(out.subarray(start, end))
    } catch {
      throw fail(commit)
    }
    if (/^[0-9a-f]{40}$/.test(token)) commit = token
    tokens.push(token)
    start = end + 1
  }
  return tokens
}

function pathError(sha) {
  return new ConfigError(`commit ${sha} has a path that is not valid UTF-8`)
}

// Splits a raw commit or tag object into its headers (first value of each key) and raw message.
// A non-UTF-8 encoding header or bytes that are not valid UTF-8 are errors (SHA only).
function parseObject(data, kind, sha) {
  const text = data.toString('utf8')
  const blank = text.indexOf('\n\n')
  const headers = new Map()
  for (const line of (blank === -1 ? text : text.slice(0, blank)).split('\n')) {
    const space = line.indexOf(' ')
    const key = space === -1 ? line : line.slice(0, space)
    if (key !== '' && !headers.has(key)) headers.set(key, line.slice(space + 1))
  }
  const encoding = headers.get('encoding')
  if (encoding !== undefined && !/^utf-?8$/i.test(encoding.trim())) {
    throw new ConfigError(`${kind} ${sha} has a non-UTF-8 encoding header`)
  }
  try {
    STRICT.decode(data)
  } catch {
    throw new ConfigError(`${kind} ${sha} is not valid UTF-8`)
  }
  return { headers, message: blank === -1 ? '' : text.slice(blank + 2) }
}

// "Name <email> 1767225600 +0200" -> identity "Name <email>", offset "+0200".
function parsePerson(value = '') {
  const match = /^(.*) \d+ ([+-]\d{4})$/.exec(value)
  return match ? { identity: match[1], offset: match[2] } : { identity: value, offset: '' }
}

function personHits(person, patterns, identities) {
  const hits = matching(patterns, person.identity).map((id) => `pattern#=${id}`)
  if (identities.size > 0 && !identities.has(person.identity)) hits.push('reason=not-allowed')
  return hits
}

function listRefs(root, options) {
  const remote = `refs/remotes/${options.remote}/`
  const format = '--format=%(refname)%00%(objectname)%00%(objecttype)'
  const refs = []
  const raw = git(root, ['for-each-ref', '--sort=refname', format])
  const out = strictTokens(raw, '', () => new ConfigError('a ref name is not valid UTF-8')).join(
    '\0',
  )
  for (const line of out.split('\n')) {
    const [name = '', oid, type] = line.split('\0')
    const inScope =
      name.startsWith('refs/tags/') ||
      (name.startsWith('refs/heads/') && !options.skip.has(name)) ||
      (name.startsWith(remote) && name !== `${remote}HEAD`)
    if (inScope) refs.push({ number: refs.length + 1, name, oid, type })
  }
  return refs
}

// Checks ref names and annotated tags (peeling tag chains) and collects the commit tips. The
// name stored inside a tag object counts as a ref name: it can differ from the ref's own name.
function scanRefs(root, refs, patterns, identities) {
  const hits = []
  const tips = new Set()
  for (const ref of refs) {
    const names = [ref.name]
    const tagHits = []
    let { oid, type } = ref
    while (type === 'tag') {
      const tag = parseObject(readObject(root, oid).data, 'tag', oid)
      names.push(tag.headers.get('tag') ?? '')
      for (const id of matching(patterns, tag.message)) {
        tagHits.push(`field=annotation pattern#=${id}`)
      }
      if (tag.headers.has('tagger')) {
        const tagger = parsePerson(tag.headers.get('tagger'))
        for (const hit of personHits(tagger, patterns, identities)) {
          tagHits.push(`field=tagger ${hit}`)
        }
        if (tagger.offset !== '+0000') tagHits.push('field=tagger-offset')
      }
      oid = tag.headers.get('object')
      type = tag.headers.get('type')
    }
    if (type !== 'commit') throw new ConfigError(`ref#${ref.number} does not point to a commit`)
    tips.add(oid)
    const refIds = new Set(names.flatMap((name) => matching(patterns, name)))
    for (const id of [...refIds].sort((a, b) => a - b)) {
      hits.push(`ref ref#=${ref.number} pattern#=${id}`)
    }
    for (const hit of tagHits) hits.push(`tag ref#=${ref.number} ${hit}`)
  }
  return { hits, tips }
}

function listCommits(root, tips) {
  if (tips.size === 0) return []
  const args = ['rev-list', '--topo-order', '--reverse', '--stdin']
  const out = git(root, args, `${[...tips].join('\n')}\n`).toString('latin1')
  return out.split('\n').filter((sha) => sha !== '')
}

// Every (commit, path, mode, blob) where no parent of the commit has that blob at that path.
// `diff-tree -c` lists for a merge only the paths that differ from every parent, and --root
// makes a root commit introduce its whole tree.
function listIntroductions(root, commits) {
  if (commits.length === 0) return []
  const args = ['diff-tree', '--stdin', '-r', '-c', '--root', '--raw', '-z', '--no-renames']
  const tokens = strictTokens(git(root, args, `${commits.join('\n')}\n`), '', pathError)
  const introduced = []
  let commit = ''
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (token.startsWith(':')) {
      const parents = token.length - token.replace(/^:+/, '').length
      const fields = token.slice(parents).split(' ')
      const mode = fields[parents]
      const blob = fields[2 * parents + 1]
      const before = fields.slice(parents + 1, 2 * parents + 1)
      if (mode !== '000000' && !before.includes(blob)) {
        introduced.push({ commit, path: tokens[i + 1], mode, blob })
      }
      i += 2
    } else {
      if (token !== '') commit = token
      i += 1
    }
  }
  return introduced
}

// Content: each (blob, path) at the first commit that introduces it. Paths: each path at the
// first commit that introduces it. Submodule entries (mode 160000) have no content here.
function scanTrees(root, commits, patterns, hitsOf) {
  const seenPaths = new Set()
  const seenPairs = new Set()
  const fresh = []
  for (const entry of listIntroductions(root, commits)) {
    const pair = `${entry.blob} ${entry.path}`
    const newPath = !seenPaths.has(entry.path)
    const newContent = entry.mode !== '160000' && !seenPairs.has(pair)
    seenPaths.add(entry.path)
    seenPairs.add(pair)
    if (newPath || newContent) fresh.push({ ...entry, newPath, newContent })
  }
  const blobs = [...new Set(fresh.filter((entry) => entry.newContent).map((entry) => entry.blob))]
  const blobHits = new Map()
  readObjects(root, blobs, (oid, _type, data) => {
    const ids = new Set(blobTexts(data).flatMap((text) => matching(patterns, text)))
    blobHits.set(
      oid,
      [...ids].sort((a, b) => a - b),
    )
  })
  const numbers = new Map()
  const pathNumber = (commit, path) => {
    if (!numbers.has(commit)) {
      const args = ['ls-tree', '-r', '-z', '--full-tree', '--name-only', commit]
      const names = strictTokens(git(root, args), commit, pathError)
      numbers.set(commit, new Map(names.map((name, index) => [name, index + 1])))
    }
    return numbers.get(commit).get(path)
  }
  for (const { commit, path, blob, newPath, newContent } of fresh) {
    const hits = hitsOf.get(commit)
    for (const id of newContent ? blobHits.get(blob) : []) {
      hits.push(`content commit=${commit} path#=${pathNumber(commit, path)} pattern#=${id}`)
    }
    for (const id of newPath ? matching(patterns, path) : []) {
      hits.push(`path commit=${commit} path#=${pathNumber(commit, path)} pattern#=${id}`)
    }
  }
  return { blobs: blobs.length, paths: seenPaths.size }
}

function scanCommits(root, commits, patterns, identities, hitsOf) {
  readObjects(root, commits, (sha, _type, data) => {
    const commit = parseObject(data, 'commit', sha)
    // A merge of a signed tag embeds that tag (tagger, offset, annotation) in this header.
    if (commit.headers.has('mergetag')) {
      throw new ConfigError(`commit ${sha} has a mergetag header, which scan-repo does not scan`)
    }
    const hits = hitsOf.get(sha)
    for (const id of matching(patterns, commit.message)) {
      hits.push(`message commit=${sha} pattern#=${id}`)
    }
    for (const field of ['author', 'committer']) {
      const person = parsePerson(commit.headers.get(field))
      for (const hit of personHits(person, patterns, identities)) {
        hits.push(`identity commit=${sha} field=${field} ${hit}`)
      }
      if (person.offset !== '+0000') hits.push(`offset commit=${sha} field=${field}`)
    }
  })
}

function scan(options) {
  const dir = resolve(options.repo)
  if (!existsSync(dir)) throw new ConfigError('the --repo directory does not exist')
  const top = run(dir, ['rev-parse', '--show-toplevel'])
  if (top.status !== 0) throw new ConfigError('--repo is not inside a git work tree')
  const root = top.stdout.toString('utf8').replace(/\r?\n$/, '')
  const patterns = loadPatterns(root)
  const accepted = loadAccepted(root)
  const refs = listRefs(root, options)
  const refScan = scanRefs(root, refs, patterns, options.identities)
  const commits = listCommits(root, refScan.tips)
  const hitsOf = new Map(commits.map((sha) => [sha, []]))
  const counts = scanTrees(root, commits, patterns, hitsOf)
  scanCommits(root, commits, patterns, options.identities, hitsOf)
  const hits = [
    ...commits.flatMap((sha) => hitsOf.get(sha).map((text) => ({ text, ok: accepted.has(sha) }))),
    ...refScan.hits.map((text) => ({ text, ok: false })),
  ]
  const acceptedCount = hits.filter((hit) => hit.ok).length
  const summary = [
    `${refs.length} refs`,
    `${commits.length} commits`,
    `${counts.blobs} blobs`,
    `${counts.paths} paths`,
    `${patterns.length} patterns`,
  ]
  const lines = [
    `scan-repo: ${summary.join(', ')}`,
    ...hits.map((hit) => `${hit.ok ? 'ACCEPTED' : 'HIT'} ${hit.text}`),
    `result: ${hits.length} hits (${acceptedCount} accepted)`,
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  return acceptedCount === hits.length ? 0 : 1
}

function main(argv) {
  try {
    return scan(parseArgs(argv))
  } catch (error) {
    // An unexpected error's message or stack could carry repository data, so only its name.
    const message = error instanceof ConfigError ? error.message : `unexpected ${error?.name}`
    process.stderr.write(`scan-repo: ${message}\n`)
    return 2
  }
}

process.exitCode = main(process.argv.slice(2))
