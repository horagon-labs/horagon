// Keeps docs/runbook.md in step with the alerts the code can send: every key prefix the keeper,
// its watchdog and horagon-ops pass to `Alerter.send` has a row in the runbook's alert table, and
// the runbook names no key the code never sends. The extractor is small and explicit: it reads
// the first argument of every `alerts.send(` in apps/keeper/src, and follows the two places that
// pass a key through a variable (listed in INDIRECT, which fails the test when a new one appears).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PERSON_ALERT_SECS, personAlertWindow } from '../src/alerts'

const APP_DIR = join(import.meta.dirname, '..')
const SRC_DIR = join(APP_DIR, 'src')
const RUNBOOK = join(APP_DIR, '../../docs/runbook.md')

interface Source {
  file: string
  text: string
}

const sources: Source[] = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f.replaceAll('\\', '/'), text: readFileSync(join(SRC_DIR, f), 'utf8') }))

/** A key's prefix: the literal text before its first `:` or interpolation. */
const prefixOf = (literal: string) => literal.split(/:|\$\{/)[0] ?? ''

/** The first argument at `text[start]`: a string or template literal, or another expression. */
function firstArgument(text: string, start: number): { literal: string } | { expr: string } {
  const quote = text[start]
  if (quote === "'" || quote === '"' || quote === '`') {
    const end = text.indexOf(quote, start + 1)
    return { literal: text.slice(start + 1, end) }
  }
  let depth = 0
  let template = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '`') template = !template
    else if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    if (!template && (depth < 0 || (depth === 0 && c === ','))) {
      return { expr: text.slice(start, i).trim() }
    }
  }
  throw new Error('unterminated alerts.send call')
}

interface SendSite {
  file: string
  arg: { literal: string } | { expr: string }
}

function sendSites(): SendSite[] {
  const sites: SendSite[] = []
  for (const { file, text } of sources) {
    for (const m of text.matchAll(/\balerts\.send\(\s*/g)) {
      sites.push({ file, arg: firstArgument(text, (m.index ?? 0) + m[0].length) })
    }
  }
  return sites
}

/**
 * The call sites that pass a key through a variable, and where those keys come from. A new
 * indirect site fails 'reads the key of every alerts.send call' until it is added here.
 */
const INDIRECT: Array<{ file: string; matches: (expr: string) => boolean; keys: () => string[] }> =
  [
    {
      // The tick and index failure streaks (loop.ts `FailureStreak`): `<name>-failing`.
      file: 'main.ts',
      matches: (expr) => expr === 'alert.key',
      keys: () =>
        sources.flatMap(({ text }) =>
          [...text.matchAll(/new FailureStreak\(\s*'([a-z-]+)'/g)].map((m) => `${m[1]}-failing`),
        ),
    },
    {
      // The `alert` actions of the planner and of `stuckAlerts` (tick.ts), whose key is a `key:`
      // property or a `const key =` (`unconfirmed:` gets the challenge round appended).
      file: 'tick.ts',
      matches: (expr) => /\ba\.key$/.test(expr),
      keys: () =>
        sources.flatMap(({ text }) =>
          [...text.matchAll(/\bkey(?:\s*:|\s*=)\s*['"`]([a-z][a-z0-9-]*)(?=[:'"`$])/g)].map(
            (m) => m[1] ?? '',
          ),
        ),
    },
  ]

function codeKeys(): Set<string> {
  const keys = new Set<string>()
  for (const site of sendSites()) {
    if ('literal' in site.arg) keys.add(prefixOf(site.arg.literal))
  }
  for (const indirect of INDIRECT) for (const k of indirect.keys()) keys.add(prefixOf(k))
  return keys
}

/** The runbook's `## Alerts` section. */
function alertsSection(): string {
  const text = readFileSync(RUNBOOK, 'utf8')
  const start = text.indexOf('\n## Alerts\n')
  if (start < 0) throw new Error('docs/runbook.md has no "## Alerts" section')
  const end = text.indexOf('\n## ', start + 1)
  return text.slice(start, end < 0 ? undefined : end)
}

/** Alert notation: `key`, `key:`, `key:<id>` or `key:<id>:<count>`. */
const KEY_TOKEN = /^([a-z][a-z0-9-]*)(?::(?:<[^>]*>(?::<[^>]*>)*)?)?$/

interface TableRow {
  keys: string[]
  repeats: string
}

function tableRows(): TableRow[] {
  const lines = alertsSection()
    .split('\n')
    .filter((l) => l.startsWith('|'))
  // The header and the separator row come first.
  return lines.slice(2).map((line) => {
    const cells = line.split('|').map((c) => c.trim())
    const keys = [...(cells[1] ?? '').matchAll(/`([^`]+)`/g)].map((m) => {
      const token = KEY_TOKEN.exec(m[1] ?? '')
      if (!token) throw new Error(`not an alert key in the runbook table: ${m[1]}`)
      return token[1] ?? ''
    })
    return { keys, repeats: cells[3] ?? '' }
  })
}

/**
 * `key:` and `key:<...>` anywhere else in the runbook (prose and procedures, not code blocks).
 * Not alerts: the `propose:<gameId>` row of keeper_heartbeats.
 */
const NOT_ALERT_KEYS = new Set(['propose'])

/** A backticked bare word: a bare alert key (`rpc-backup-down`, `archive`) has this shape. */
const BARE_WORD = /^[a-z][a-z0-9-]*$/

/**
 * The backticked bare words of the runbook that are not alert keys: commands, keeper steps and
 * heartbeat fields, market states and halt rules. Every other bare word in backticks must be a
 * key the code sends, so a bare key the code no longer sends cannot linger in the prose. A new
 * word that is not an alert key goes here.
 */
const NOT_ALERT_WORDS = new Set([
  // horagon-ops and its commands
  'horagon-ops',
  'propose',
  'init-config',
  'pause',
  'resume',
  'fund-authority',
  'status',
  'flag',
  'backfill-bot-memo',
  // keeper actions and steps, fields of its heartbeat row
  'create',
  'finalize',
  'recycle',
  'schedule',
  'keeper',
  'round',
  'actions',
  'feed',
  'alert',
  // market and draft states, halt rules
  'featured',
  'proposed',
  'finalized',
  'recycled',
  'postponed',
  'final-before-end',
  'not-started',
  // other words
  'devnet',
  'horagon',
  'ok',
  'outcome',
])

/** The alert keys the runbook names, bare or with a colon, outside code blocks. */
function proseKeys(): Set<string> {
  const text = readFileSync(RUNBOOK, 'utf8').replace(/```[\s\S]*?```/g, '')
  const keys = new Set<string>()
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1] ?? ''
    if (!token.includes(':')) {
      if (BARE_WORD.test(token) && !NOT_ALERT_WORDS.has(token)) keys.add(token)
      continue
    }
    const key = KEY_TOKEN.exec(token)?.[1]
    if (key && !NOT_ALERT_KEYS.has(key)) keys.add(key)
  }
  return keys
}

const isPersonAlert = (prefix: string) =>
  personAlertWindow(prefix) === PERSON_ALERT_SECS ||
  personAlertWindow(`${prefix}:x`) === PERSON_ALERT_SECS

describe('docs/runbook.md and the alert keys in the code', () => {
  it('reads the key of every alerts.send call', () => {
    const sites = sendSites()
    expect(sites.length).toBeGreaterThan(25)
    for (const site of sites) {
      if ('literal' in site.arg) {
        expect(prefixOf(site.arg.literal), `${site.file}: ${site.arg.literal}`).toMatch(
          /^[a-z][a-z0-9-]*$/,
        )
        continue
      }
      const { expr } = site.arg
      const known = INDIRECT.find((i) => i.file === site.file && i.matches(expr))
      expect(known, `${site.file}: alerts.send(${expr}, ...) is not in INDIRECT`).toBeDefined()
    }
    // Every `.send(` is an alert or a TxSender send, so an Alerter under another name is seen.
    for (const { file, text } of sources) {
      for (const m of text.matchAll(/(\w+)\s*\.send\(/g)) {
        expect(['alerts', 'sender'], `${file}: ${m[0]}`).toContain(m[1])
      }
    }
  })

  it('finds the keys that must be in the runbook', () => {
    const keys = codeKeys()
    for (const k of [
      'draft',
      'unconfirmed',
      'challenge',
      'evidence-mismatch',
      'periods',
      'tie',
      'no-feed',
      'feed-silent',
      'feed-silent-q4',
      'tx',
      'tx-unresolved',
      'tick-failing',
      'index-failing',
      'index-stuck',
      'index-skip',
      'ata-close',
      'rpc-backup-down',
      'archive',
      'heartbeat',
      'watchdog',
    ]) {
      expect(keys).toContain(k)
    }
  })

  it('has a runbook row for every key prefix the code can send', () => {
    const documented = new Set(tableRows().flatMap((r) => r.keys))
    const missing = [...codeKeys()].filter((k) => !documented.has(k)).sort()
    expect(missing).toEqual([])
  })

  it('names no key the code never sends, in the table or anywhere else', () => {
    const code = codeKeys()
    const rows = tableRows()
    for (const row of rows) expect(row.keys.length, 'a table row without a key').toBeGreaterThan(0)
    const table = rows.flatMap((r) => r.keys)
    expect(table.filter((k) => !code.has(k))).toEqual([])
    expect(new Set(table).size, 'a key with two rows').toBe(table.length)
    expect(
      [...proseKeys()].filter((k) => !code.has(k)).sort(),
      'backticked in the runbook but not a key the code sends (a word that is no alert key goes in NOT_ALERT_WORDS)',
    ).toEqual([])
  })

  it('lists in NOT_ALERT_WORDS no key the code sends', () => {
    const code = codeKeys()
    expect([...NOT_ALERT_WORDS].filter((w) => code.has(w))).toEqual([])
  })

  it('says "3 h" for exactly the keys that wait on a person', () => {
    for (const row of tableRows()) {
      for (const key of row.keys) {
        expect(/\b3 h\b/.test(row.repeats), `${key}: "${row.repeats}"`).toBe(isPersonAlert(key))
      }
    }
  })
})
