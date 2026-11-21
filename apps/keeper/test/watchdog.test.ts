import { type Db, type DbHandle, getHeartbeat, heartbeat, upsertScheduledGames } from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Alerter } from '../src/alerts'
import { WATCHDOG_REPAGE_SECS, watchdogPage, watchdogRun } from '../src/ops/watchdog'

const silent = pino({ level: 'silent' })

describe('watchdogPage', () => {
  it('pages at once, then again only after 15 min while stale; fresh resets it', () => {
    expect(WATCHDOG_REPAGE_SECS).toBe(900)
    expect(watchdogPage(true, null, 1_000)).toEqual({ page: true, pagedAt: 1_000 })
    expect(watchdogPage(true, 1_000, 1_120)).toEqual({ page: false, pagedAt: 1_000 })
    expect(watchdogPage(true, 1_000, 1_899)).toEqual({ page: false, pagedAt: 1_000 })
    expect(watchdogPage(true, 1_000, 1_900)).toEqual({ page: true, pagedAt: 1_900 })
    expect(watchdogPage(false, 1_000, 1_120)).toEqual({ page: false, pagedAt: null })
    expect(watchdogPage(false, null, 1_120)).toEqual({ page: false, pagedAt: null })
  })
})

describe('watchdogRun', () => {
  let h: DbHandle
  const sent: Array<[string, string]> = []
  const alerts: Alerter = { send: async (key, text) => void sent.push([key, text]) }
  const real = () => Math.floor(Date.now() / 1000)

  beforeEach(async () => {
    sent.length = 0
    h = await createTestDb()
    await upsertScheduledGames(h.db, [
      {
        id: 'nba-401910007',
        league: 'NBA',
        externalId: '401910007',
        gameDate: '2026-11-18',
        home: 'CLE',
        away: 'MEM',
        // In progress: a game window for the next few hours.
        scheduledTipoff: new Date((real() - 3_600) * 1000),
        status: 'live',
        p0: 0.62,
      },
    ])
  })
  afterEach(async () => {
    await h.close()
  })

  it('pages a stale heartbeat once per 15 min, keeping the page time in the DB', async () => {
    await heartbeat(h.db, 'keeper', { round: 1 })
    const t = real() + 600
    expect(await watchdogRun(h.db, alerts, t, silent)).toBe(2)
    expect(sent.map(([k]) => k)).toEqual(['heartbeat'])
    expect(sent[0]?.[1]).toMatch(/Keeper heartbeat is 6\d\d s old/)
    expect((await getHeartbeat(h.db, 'watchdog'))?.info).toEqual({ pagedAt: t })

    // The timer's next runs (every 2 min) stay quiet, still exit 2.
    expect(await watchdogRun(h.db, alerts, t + 120, silent)).toBe(2)
    expect(await watchdogRun(h.db, alerts, t + 899, silent)).toBe(2)
    expect(sent).toHaveLength(1)
    expect(await watchdogRun(h.db, alerts, t + 900, silent)).toBe(2)
    expect(sent.map(([k]) => k)).toEqual(['heartbeat', 'heartbeat'])
    expect((await getHeartbeat(h.db, 'watchdog'))?.info).toEqual({ pagedAt: t + 900 })
  })

  it('forgets the page once the heartbeat is fresh, so the next stall pages at once', async () => {
    await heartbeat(h.db, 'keeper', { round: 1 })
    const t = real() + 600
    await watchdogRun(h.db, alerts, t, silent)
    await heartbeat(h.db, 'keeper', { round: 2 })
    expect(await watchdogRun(h.db, alerts, real(), silent)).toBe(0)
    expect((await getHeartbeat(h.db, 'watchdog'))?.info).toEqual({ pagedAt: null })
    expect(await watchdogRun(h.db, alerts, real() + 300, silent)).toBe(2)
    expect(sent.map(([k]) => k)).toEqual(['heartbeat', 'heartbeat'])
  })

  it('stays quiet and writes nothing outside a game window', async () => {
    await heartbeat(h.db, 'keeper', { round: 1 })
    expect(await watchdogRun(h.db, alerts, real() + 6 * 3_600, silent)).toBe(0)
    expect(sent).toEqual([])
    expect(await getHeartbeat(h.db, 'watchdog')).toBeNull()
  })

  it('pages on every run when the DB cannot be read (nothing to keep a page time in)', async () => {
    const broken = {} as Db
    for (let run = 0; run < 2; run++) {
      await expect(watchdogRun(broken, alerts, real() + run * 120, silent)).rejects.toThrow()
    }
    expect(sent.map(([k]) => k)).toEqual(['watchdog', 'watchdog'])
    expect(sent[0]?.[1]).toContain('cannot read the keeper heartbeat')
  })
})
