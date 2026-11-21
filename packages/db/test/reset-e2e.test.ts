import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getTableName, is, sql } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DbHandle } from '../src/client'
import { listOps, logOps } from '../src/ops'
import {
  checkResetGuard,
  databaseUrlFromEnvFile,
  type ResetGuardInput,
  schemaTableNames,
  truncateAll,
} from '../src/reset-e2e'
import * as schema from '../src/schema'
import { createTestDb } from '../src/testing'

const E2E = 'postgres://fake-e2e-user:fake-pass@e2e.example.test:6543/postgres'
const DEVNET = 'postgres://fake-dev-user:fake-pass@devnet.example.test:6543/postgres'
const ok: ResetGuardInput = {
  cluster: 'localnet',
  resetFlag: 'yes',
  databaseUrl: E2E,
  e2eUrl: E2E,
  devnetUrl: DEVNET,
}

describe('checkResetGuard', () => {
  it('accepts the one case where every condition holds', () => {
    expect(checkResetGuard(ok)).toEqual({ ok: true })
  })

  it('accepts when there is no .env.devnet', () => {
    expect(checkResetGuard({ ...ok, devnetUrl: undefined })).toEqual({ ok: true })
  })

  const refusals: [string, Partial<ResetGuardInput>, string][] = [
    ['cluster is devnet', { cluster: 'devnet' }, 'HORAGON_CLUSTER must be localnet'],
    ['cluster is unset', { cluster: undefined }, 'HORAGON_CLUSTER must be localnet'],
    ['the flag is unset', { resetFlag: undefined }, 'HORAGON_E2E_RESET=yes is not set'],
    ['the flag is not "yes"', { resetFlag: '1' }, 'HORAGON_E2E_RESET=yes is not set'],
    ['DATABASE_URL is unset', { databaseUrl: undefined }, 'DATABASE_URL is not set'],
    ['.env.e2e has no URL', { e2eUrl: undefined }, '.env.e2e has no DATABASE_URL'],
    [
      'DATABASE_URL differs from .env.e2e',
      { databaseUrl: 'postgres://other.example.test/x' },
      'DATABASE_URL does not match the one in .env.e2e',
    ],
    [
      'DATABASE_URL equals .env.devnet',
      { databaseUrl: DEVNET, e2eUrl: DEVNET },
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

describe('databaseUrlFromEnvFile', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'horagon-env-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const write = (name: string, text: string) => {
    const p = join(dir, name)
    writeFileSync(p, text)
    return p
  }

  it('reads only DATABASE_URL, with quotes, export and CRLF handled', () => {
    expect(databaseUrlFromEnvFile(write('a', `OTHER=1\nDATABASE_URL=${E2E}\nX=2\n`))).toBe(E2E)
    expect(databaseUrlFromEnvFile(write('b', `export DATABASE_URL="${E2E}"\r\n`))).toBe(E2E)
    expect(databaseUrlFromEnvFile(write('c', `DATABASE_URL='${E2E}'\n`))).toBe(E2E)
  })

  it('is undefined for a missing file, a missing line or an empty value', () => {
    expect(databaseUrlFromEnvFile(join(dir, 'nope'))).toBeUndefined()
    expect(databaseUrlFromEnvFile(write('d', 'X_DATABASE_URL=a\nOTHER=b\n'))).toBeUndefined()
    expect(databaseUrlFromEnvFile(write('e', 'DATABASE_URL=\n'))).toBeUndefined()
  })
})

describe('truncateAll', () => {
  it('lists every pgTable that schema.ts exports', () => {
    const exported = Object.values(schema)
      .filter((v) => is(v, PgTable))
      .map((t) => getTableName(t as PgTable))
    expect(exported.length).toBeGreaterThan(10)
    expect(schemaTableNames().sort()).toEqual(exported.sort())
  })

  let handle: DbHandle
  beforeAll(async () => {
    handle = await createTestDb()
  }, 60_000)
  afterAll(() => handle.close())

  it('empties the tables, restarts identities and keeps the schema', async () => {
    await logOps(handle.db, { actor: 'keeper', action: 'before-reset' })
    expect(await listOps(handle.db)).toHaveLength(1)
    expect(await truncateAll(handle.db)).toBe(schemaTableNames().length)
    expect(await listOps(handle.db)).toHaveLength(0)
    await logOps(handle.db, { actor: 'keeper', action: 'after-reset' })
    expect((await listOps(handle.db))[0]?.id).toBe(1)
    const res = (await handle.db.execute(
      sql`select count(*) as n from information_schema.tables where table_schema = 'public'`,
    )) as unknown as { rows: { n: string }[] }
    expect(Number(res.rows[0]?.n)).toBe(schemaTableNames().length)
  })
})
