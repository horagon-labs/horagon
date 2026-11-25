// Tier 2 feature flags (spec 3.3): every feature sits behind one, and every flag is off until
// `horagon-ops flag on` turns it on. The API reads them on each request, so turning one off
// needs no deploy. A name with no row is off; a row whose name is no flag is ignored.
import type { Db } from './client'
import { flags, opsEvents } from './schema'

export const FLAG_NAMES = [
  'FLAG_ME',
  'FLAG_METRICS',
  'FLAG_METRICS_COHORT',
  'FLAG_SHARE',
  'FLAG_RANK',
  'FLAG_CREWS',
  'FLAG_TELEGRAM',
  'FLAG_CLUTCH',
  'FLAG_PRACTICE',
  'FLAG_VERIFY',
] as const

export type FlagName = (typeof FLAG_NAMES)[number]
export type Flags = Record<FlagName, boolean>

const NAMES: ReadonlySet<string> = new Set(FLAG_NAMES)

export function isFlagName(name: string): name is FlagName {
  return NAMES.has(name)
}

/** Every flag off: what an empty table reads as. */
export function allFlagsOff(): Flags {
  return Object.fromEntries(FLAG_NAMES.map((name) => [name, false])) as Flags
}

export async function readFlags(db: Db): Promise<Flags> {
  const out = allFlagsOff()
  const rows = await db.select({ name: flags.name, enabled: flags.enabled }).from(flags)
  for (const row of rows) if (isFlagName(row.name)) out[row.name] = row.enabled
  return out
}

/** Turns `name` on or off and logs it in `ops_events` with actor `by`: both or neither. */
export async function setFlag(db: Db, name: FlagName, on: boolean, by: string): Promise<void> {
  if (!isFlagName(name)) throw new Error(`unknown flag "${String(name)}"`)
  if (by.trim() === '') throw new Error('setFlag needs who set it')
  const now = new Date()
  await db.transaction(async (tx) => {
    await tx
      .insert(flags)
      .values({ name, enabled: on, updatedAt: now, updatedBy: by })
      .onConflictDoUpdate({
        target: flags.name,
        set: { enabled: on, updatedAt: now, updatedBy: by },
      })
    await tx.insert(opsEvents).values({ ts: now, actor: by, action: 'flag', detail: { name, on } })
  })
}
