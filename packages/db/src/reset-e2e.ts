// The guarded reset of the end-to-end database (`pnpm --filter @horagon/db db:reset-e2e`).
// Nothing here prints, logs or returns a database URL, and no error message quotes one.
import { existsSync, readFileSync } from 'node:fs'
import { getTableName, is, sql } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import type { Db } from './client'
import * as schema from './schema'

export interface ResetGuardInput {
  /** `HORAGON_CLUSTER` */
  cluster: string | undefined
  /** `HORAGON_E2E_RESET` */
  resetFlag: string | undefined
  /** `process.env.DATABASE_URL` */
  databaseUrl: string | undefined
  /** Every `DATABASE_URL` assignment in `.env.e2e`, in file order; [] when none */
  e2eUrls: string[]
  /** Every `DATABASE_URL` assignment in `.env.devnet`, in file order; [] when none */
  devnetUrls: string[]
}

export type ResetGuardResult = { ok: true } | { ok: false; reason: string }

/** Every refusal is a fixed message: none quotes a URL. */
export function checkResetGuard(i: ResetGuardInput): ResetGuardResult {
  if (i.cluster !== 'localnet') return { ok: false, reason: 'HORAGON_CLUSTER must be localnet' }
  if (i.resetFlag !== 'yes') return { ok: false, reason: 'HORAGON_E2E_RESET=yes is not set' }
  if (!i.databaseUrl) return { ok: false, reason: 'DATABASE_URL is not set' }
  if (i.e2eUrls.length === 0) return { ok: false, reason: '.env.e2e has no DATABASE_URL' }
  // Bash `. ./file` keeps the last assignment.
  if (i.e2eUrls[i.e2eUrls.length - 1] !== i.databaseUrl) {
    return { ok: false, reason: 'DATABASE_URL does not match the one in .env.e2e' }
  }
  if (i.devnetUrls.includes(i.databaseUrl)) {
    return { ok: false, reason: 'DATABASE_URL is the one in .env.devnet' }
  }
  return { ok: true }
}

/**
 * Every `DATABASE_URL` assignment in a dotenv file, in file order, read the way bash `. ./file`
 * reads a simple line: a quoted value ends at its closing quote (an unclosed quote skips the
 * line); an unquoted value is cut at whitespace followed by `#`. Empty values are dropped; a
 * missing file gives [].
 */
export function databaseUrlsFromEnvFile(path: string): string[] {
  if (!existsSync(path)) return []
  const urls: string[] = []
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(raw)) continue
    const m = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)$/.exec(raw)
    if (!m) continue
    const rest = m[1] ?? ''
    let value: string
    const q = rest[0]
    if (q === '"' || q === "'") {
      const end = rest.indexOf(q, 1)
      if (end === -1) continue
      value = rest.slice(1, end)
    } else {
      value = rest.replace(/\s+#.*$/, '').trim()
    }
    if (value !== '') urls.push(value)
  }
  return urls
}

/**
 * What the CLI may print about a failure: a fixed message plus the error code when it looks like
 * a Node code (ENOTFOUND) or a SQLSTATE (28P01). Never the message, the stack or any other field:
 * the driver puts hosts, ports and user names there, and those are parts of the database URL.
 */
export function describeResetError(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)
    ? `db:reset-e2e failed (${code})`
    : 'db:reset-e2e failed'
}

/** Names of every table `schema.ts` defines, read from the module rather than listed by hand. */
export function schemaTableNames(): string[] {
  return Object.values(schema)
    .filter((v) => is(v, PgTable))
    .map((t) => getTableName(t as PgTable))
}

/** Empties every schema table and restarts identities. Keeps the schema and the migrations table. */
export async function truncateAll(db: Db): Promise<number> {
  const names = schemaTableNames()
  const list = sql.join(
    names.map((n) => sql.identifier(n)),
    sql`, `,
  )
  await db.execute(sql`truncate table ${list} restart identity cascade`)
  return names.length
}
