import { type DbHandle, getHeartbeat, logOps } from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Alerter } from '../src/alerts'
import { pageSponsorMarks } from '../src/sponsor-marks'

const silent = pino({ level: 'silent' })

describe('pageSponsorMarks', () => {
  let h: DbHandle
  let sent: Array<[string, string]>
  let delivered: boolean
  const alerts: Alerter = {
    send: async (key, text) => {
      sent.push([key, text])
      return delivered
    },
  }
  const now = () => Math.floor(Date.now() / 1000)
  const run = () => pageSponsorMarks({ db: h.db, alerts, log: silent, now })
  const mark = (pct: number, day = new Date().toISOString().slice(0, 10)) =>
    logOps(h.db, {
      actor: 'api',
      action: `sponsor-cap-${pct}`,
      detail: { day, spentLamports: '1500000000', capLamports: '2000000000' },
    })

  beforeEach(async () => {
    h = await createTestDb()
    sent = []
    delivered = true
  })
  afterEach(async () => {
    await h.close()
  })

  it('pages each mark the API logged once, across restarts', async () => {
    expect(await run()).toBe(0)
    await mark(50)
    await logOps(h.db, { actor: 'keeper', action: 'create' })
    expect(await run()).toBe(1)
    const day = new Date().toISOString().slice(0, 10)
    expect(sent.map(([k]) => k)).toEqual([`sponsor-cap:50:${day}`])
    expect(sent[0]?.[1]).toContain('50%')
    expect(sent[0]?.[1]).toContain('1.5 of 2 SOL')
    // A new process: what was paged is kept in the database, not in memory.
    expect(await run()).toBe(0)
    await mark(80)
    expect(await run()).toBe(1)
    expect(sent.map(([k]) => k)).toEqual([`sponsor-cap:50:${day}`, `sponsor-cap:80:${day}`])
    expect(await getHeartbeat(h.db, 'sponsor-marks')).not.toBeNull()
  })

  it('pages again on the next run when Telegram did not take it', async () => {
    await mark(80)
    delivered = false
    expect(await run()).toBe(0)
    delivered = true
    expect(await run()).toBe(1)
    expect(sent).toHaveLength(2)
  })
})
