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
  /** `DATABASE_URL` from `.env.e2e`; undefined when the file or the line is missing */
  e2eUrl: string | undefined
  /** `DATABASE_URL` from `.env.devnet`; undefined when there is no such file or line */
  devnetUrl: string | undefined
}

export type ResetGuardResult = { ok: true } | { ok: false; reason: string }

/** Every refusal is a fixed message: none quotes a URL. */
export function checkResetGuard(i: ResetGuardInput): ResetGuardResult {
  if (i.cluster !== 'localnet') return { ok: false, reason: 'HORAGON_CLUSTER must be localnet' }
  if (i.resetFlag !== 'yes') return { ok: false, reason: 'HORAGON_E2E_RESET=yes is not set' }
  if (!i.databaseUrl) return { ok: false, reason: 'DATABASE_URL is not set' }
  if (!i.e2eUrl) return { ok: false, reason: '.env.e2e has no DATABASE_URL' }
  if (i.e2eUrl !== i.databaseUrl) {
    return { ok: false, reason: 'DATABASE_URL does not match the one in .env.e2e' }
  }
  if (i.devnetUrl !== undefined && i.devnetUrl === i.databaseUrl) {
    return { ok: false, reason: 'DATABASE_URL is the one in .env.devnet' }
  }
  return { ok: true }
}

/** The value of `DATABASE_URL` in a dotenv file, or undefined when there is no file or no line. */
export function databaseUrlFromEnvFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*?)\s*$/.exec(raw)
    if (!m) continue
    const value = (m[1] ?? '').replace(/^(["'])(.*)\1$/, '$2')
    return value === '' ? undefined : value
  }
  return undefined
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
