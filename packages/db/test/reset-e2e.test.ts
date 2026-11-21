import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DbHandle } from '../src/client'
import { listOps, logOps } from '../src/ops'
import {
  checkResetGuard,
  databaseUrlsFromEnvFile,
  describeResetError,
  type ResetGuardInput,
  schemaTableNames,
  truncateAll,
} from '../src/reset-e2e'
import { createTestDb } from '../src/testing'

const E2E = 'postgres://fake-e2e-user:fake-pass@e2e.example.test:6543/postgres'
const DEVNET = 'postgres://fake-dev-user:fake-pass@devnet.example.test:6543/postgres'
const ok: ResetGuardInput = {
  cluster: 'localnet',
  resetFlag: 'yes',
  databaseUrl: E2E,
  e2eUrls: [E2E],
  devnetUrls: [DEVNET],
}

describe('checkResetGuard', () => {
  it('accepts the one case where every condition holds', () => {
    expect(checkResetGuard(ok)).toEqual({ ok: true })
  })

  it('accepts when there is no .env.devnet', () => {
    expect(checkResetGuard({ ...ok, devnetUrls: [] })).toEqual({ ok: true })
  })

  const refusals: [string, Partial<ResetGuardInput>, string][] = [
    ['cluster is devnet', { cluster: 'devnet' }, 'HORAGON_CLUSTER must be localnet'],
    ['cluster is unset', { cluster: undefined }, 'HORAGON_CLUSTER must be localnet'],
    ['the flag is unset', { resetFlag: undefined }, 'HORAGON_E2E_RESET=yes is not set'],
    ['the flag is not "yes"', { resetFlag: '1' }, 'HORAGON_E2E_RESET=yes is not set'],
    ['DATABASE_URL is unset', { databaseUrl: undefined }, 'DATABASE_URL is not set'],
    ['.env.e2e has no URL', { e2eUrls: [] }, '.env.e2e has no DATABASE_URL'],
    [
      'DATABASE_URL differs from .env.e2e',
      { databaseUrl: 'postgres://other.example.test/x' },
      'DATABASE_URL does not match the one in .env.e2e',
    ],
    [
      '.env.e2e has the env URL and then another (bash keeps the last)',
      { e2eUrls: [E2E, DEVNET] },
      'DATABASE_URL does not match the one in .env.e2e',
    ],
    [
      'only the second .env.devnet value equals DATABASE_URL',
      { devnetUrls: [DEVNET, E2E] },
      'DATABASE_URL is the one in .env.devnet',
    ],
    [
      'DATABASE_URL equals .env.devnet',
      { databaseUrl: DEVNET, e2eUrls: [DEVNET] },
      'DATABASE_URL is the one in .env.devnet',
    ],
  ]
  it.each(refusals)('refuses when %s', (_name, patch, reason) => {
    const r = checkResetGuard({ ...ok, ...patch })
    expect(r).toEqual({ ok: false, reason })
    if (!r.ok) {
      for (const url of [E2E, DEVNET]) expect(r.reason).not.toContain(url)
    }
  })
})

describe('databaseUrlsFromEnvFile', () => {
  let dir: string
  let n = 0
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'horagon-env-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const read = (text: string) => {
    const p = join(dir, `env-${n++}`)
    writeFileSync(p, text)
    return databaseUrlsFromEnvFile(p)
  }

  it('reads only DATABASE_URL, with quotes, export and CRLF handled', () => {
    expect(read(`OTHER=1\nDATABASE_URL=${E2E}\nX=2\n`)).toEqual([E2E])
    expect(read(`export DATABASE_URL="${E2E}"\r\n`)).toEqual([E2E])
    expect(read(`DATABASE_URL='${E2E}'\n`)).toEqual([E2E])
  })

  it('returns every assignment in file order', () => {
    expect(read(`DATABASE_URL=${DEVNET}\nDATABASE_URL=${E2E}\n`)).toEqual([DEVNET, E2E])
  })

  it('drops an unquoted " # comment" but keeps a # with no space before it', () => {
    expect(read(`DATABASE_URL=${E2E} # note\n`)).toEqual([E2E])
    expect(read('DATABASE_URL=a#b\n')).toEqual(['a#b'])
  })

  it('keeps " #" inside a quoted value and ignores text after the closing quote', () => {
    expect(read('DATABASE_URL="a #b" # note\n')).toEqual(['a #b'])
    expect(read("DATABASE_URL='a #b'x\n")).toEqual(['a #b'])
  })

  it('ignores a commented-out line and skips an unclosed quote', () => {
    expect(read(`# DATABASE_URL=${DEVNET}\n  #DATABASE_URL=${DEVNET}\n`)).toEqual([])
    expect(read(`DATABASE_URL="${E2E}\n`)).toEqual([])
  })

  it('is [] for a missing file, a missing line or an empty value', () => {
    expect(databaseUrlsFromEnvFile(join(dir, 'nope'))).toEqual([])
    expect(read('X_DATABASE_URL=a\nOTHER=b\n')).toEqual([])
    expect(read('DATABASE_URL=\n')).toEqual([])
  })

  it('feeds the guard: a .env.devnet line with a trailing comment still refuses', () => {
    const devnetUrls = read(`DATABASE_URL=${DEVNET} # note\n`)
    const r = checkResetGuard({ ...ok, databaseUrl: DEVNET, e2eUrls: [DEVNET], devnetUrls })
    expect(r).toEqual({ ok: false, reason: 'DATABASE_URL is the one in .env.devnet' })
  })
})

describe('describeResetError', () => {
  it('adds a Node or SQLSTATE code and nothing else', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND db.fake-host.example.test'), {
      code: 'ENOTFOUND',
    })
    expect(describeResetError(err)).toBe('db:reset-e2e failed (ENOTFOUND)')
    expect(describeResetError({ code: '28P01' })).toBe('db:reset-e2e failed (28P01)')
  })

  it('leaves out a code with lower case, a dot or a wrong type', () => {
    expect(describeResetError({ code: 'fake.host' })).toBe('db:reset-e2e failed')
    expect(describeResetError({ code: 'enotfound' })).toBe('db:reset-e2e failed')
    expect(describeResetError({ code: 42 })).toBe('db:reset-e2e failed')
  })

  it('handles values that are not errors', () => {
    expect(describeResetError('boom')).toBe('db:reset-e2e failed')
    expect(describeResetError(undefined)).toBe('db:reset-e2e failed')
    expect(describeResetError(null)).toBe('db:reset-e2e failed')
  })
})

describe('truncateAll', () => {
  let handle: DbHandle
  beforeAll(async () => {
    handle = await createTestDb()
  }, 60_000)
  afterAll(() => handle.close())

  it('lists every table the migrations created, and no other', async () => {
    const res = (await handle.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    )) as unknown as { rows: { table_name: string }[] }
    const names = res.rows.map((r) => r.table_name).sort()
    expect(names.length).toBeGreaterThan(10)
    expect(names).toEqual(schemaTableNames().sort())
  })

  it('empties the tables, restarts identities and keeps the schema', async () => {
    await logOps(handle.db, { actor: 'keeper', action: 'before-reset' })
    expect(await listOps(handle.db)).toHaveLength(1)
    expect(await truncateAll(handle.db)).toBe(schemaTableNames().length)
    expect(await listOps(handle.db)).toHaveLength(0)
    await logOps(handle.db, { actor: 'keeper', action: 'after-reset' })
    expect((await listOps(handle.db))[0]?.id).toBe(1)
  })
})
