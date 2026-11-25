import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  allFlagsOff,
  type DbHandle,
  FLAG_NAMES,
  type FlagName,
  isFlagName,
  listOps,
  readFlags,
  schema,
  setFlag,
} from '../src'
import { createTestDb } from '../src/testing'

let h: DbHandle
beforeAll(async () => {
  h = await createTestDb()
})
beforeEach(async () => {
  await h.db.execute(sql`truncate table flags, ops_events restart identity`)
})
afterAll(async () => {
  await h.close()
})

describe('FLAG_NAMES', () => {
  it('lists the ten Tier 2 flags of spec 3.3, each once', () => {
    expect(FLAG_NAMES).toEqual([
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
    ])
    expect(new Set(FLAG_NAMES).size).toBe(10)
    expect(isFlagName('FLAG_ME')).toBe(true)
    expect(isFlagName('flag_me')).toBe(false)
    expect(isFlagName('NEXT_PUBLIC_FLAG_ME')).toBe(false)
  })
})

describe('readFlags', () => {
  it('reads every flag as off on an empty table', async () => {
    expect(Object.keys(allFlagsOff())).toEqual([...FLAG_NAMES])
    expect(Object.values(allFlagsOff()).every((on) => on === false)).toBe(true)
    expect(await readFlags(h.db)).toEqual(allFlagsOff())
  })

  it('ignores a row whose name is no flag', async () => {
    await h.db.execute(
      sql`insert into flags (name, enabled, updated_by) values ('FLAG_GONE', true, 'ops')`,
    )
    expect(await readFlags(h.db)).toEqual(allFlagsOff())
  })
})

describe('setFlag', () => {
  it('turns a flag on and off, logging each change in ops_events', async () => {
    await setFlag(h.db, 'FLAG_SHARE', true, 'ops')
    expect(await readFlags(h.db)).toEqual({ ...allFlagsOff(), FLAG_SHARE: true })
    await setFlag(h.db, 'FLAG_SHARE', false, 'ops')
    expect(await readFlags(h.db)).toEqual(allFlagsOff())
    const events = (await listOps(h.db)).map((e) => [e.actor, e.action, e.detail])
    expect(events).toEqual([
      ['ops', 'flag', { name: 'FLAG_SHARE', on: false }],
      ['ops', 'flag', { name: 'FLAG_SHARE', on: true }],
    ])
  })

  it('records who set it and when', async () => {
    await setFlag(h.db, 'FLAG_ME', true, 'ops')
    expect(await h.db.select().from(schema.flags)).toEqual([
      { name: 'FLAG_ME', enabled: true, updatedBy: 'ops', updatedAt: expect.any(Date) },
    ])
  })

  it('refuses a name that is no flag, and an empty actor, writing nothing', async () => {
    await expect(setFlag(h.db, 'FLAG_GONE' as FlagName, true, 'ops')).rejects.toThrow(
      'unknown flag "FLAG_GONE"',
    )
    await expect(setFlag(h.db, 'FLAG_ME', true, ' ')).rejects.toThrow('setFlag needs who set it')
    expect(await readFlags(h.db)).toEqual(allFlagsOff())
    expect(await listOps(h.db)).toEqual([])
  })

  it('writes the flag and its ops event together, or neither', async () => {
    await h.db.execute(
      sql`alter table ops_events add constraint no_flag_events check (action <> 'flag')`,
    )
    try {
      await expect(setFlag(h.db, 'FLAG_RANK', true, 'ops')).rejects.toThrow()
      expect(await readFlags(h.db)).toEqual(allFlagsOff())
    } finally {
      await h.db.execute(sql`alter table ops_events drop constraint no_flag_events`)
    }
  })
})
