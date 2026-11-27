// R8: GET /api/v1/practice (FLAG_PRACTICE), and GET /games never lists a PRACTICE game.
import { getHeartbeat, heartbeat, setFlag, updateGameLive, upsertScheduledGames } from '@horagon/db'
import { PracticeResponseSchema } from '@horagon/sdk'
import { HoragonClient } from '@horagon/sdk/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { counterpartyOf, currentPractice, nextPracticeAt } from '../src/practice'
import { GAME_ID, makeEnv, type TestEnv } from './helpers'

/** The seeded NBA game tips off at 03:30Z on 11-20 (22:30 ET on the 19th). */
const NOW = Date.parse('2026-11-20T03:00:00Z') / 1000
const PRACTICE_ID = 'practice-401910007p0'

let env: TestEnv
let app: ReturnType<typeof createApp>
let now: number

/** A Practice run tipping off at `tip` (unix seconds), live in Q2. */
async function seedRun(tip: number) {
  await upsertScheduledGames(env.h.db, [
    {
      id: PRACTICE_ID,
      league: 'PRACTICE',
      externalId: '401910007p0',
      gameDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(
        new Date(tip * 1000),
      ),
      home: 'CLE',
      away: 'MEM',
      scheduledTipoff: new Date(tip * 1000),
      status: 'scheduled',
      p0: 0.62,
    },
  ])
  await updateGameLive(env.h.db, PRACTICE_ID, {
    status: 'live',
    homeScore: 30,
    awayScore: 33,
    period: 2,
    clockSecs: 400,
    periods: [[30, 33]],
    modelProb: 0.48,
    feedUpdatedAt: new Date(tip * 1000),
  })
}

beforeEach(async () => {
  env = await makeEnv()
  now = NOW
  app = createApp({ ...env.deps, now: () => now })
})
afterEach(async () => {
  await env.h.close()
})

const get = (path: string) => app.request(`/api/v1${path}`)
const ids = async (res: Response) =>
  ((await res.json()) as { games: Array<{ id: string }> }).games.map((g) => g.id)

/**
 * Writes a heartbeat row (stamped with the real clock) and moves the app's clock to `age`
 * seconds after it.
 */
async function beat(process: string, info: Record<string, unknown>, age = 0) {
  await heartbeat(env.h.db, process, info)
  const ts = (await getHeartbeat(env.h.db, process))?.ts
  if (!ts) throw new Error('no heartbeat')
  now = Math.floor(ts.getTime() / 1000) + age
}

describe('GET /games and Practice', () => {
  it('never lists a PRACTICE game, by default or for its ET date', async () => {
    // A run on the same ET night as the seeded NBA game.
    await seedRun(NOW - 600)
    expect(await ids(await get('/games'))).toEqual([GAME_ID])
    expect(await ids(await get('/games?date=2026-11-19'))).toEqual([GAME_ID])
  })
})

describe('GET /practice', () => {
  it('answers 404 while FLAG_PRACTICE is off', async () => {
    const res = await get('/practice')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/problem+json')
  })

  it('returns the run in flight, the next tip-off and who else trades it', async () => {
    await setFlag(env.h.db, 'FLAG_PRACTICE', true, 'test')
    await beat('practice', {
      round: 9,
      nextAt: Math.floor(Date.now() / 1000) + 7_200,
      skipped: null,
    })
    await seedRun(now - 600)
    const res = await get('/practice')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('s-maxage=1, stale-while-revalidate=5')
    const body = PracticeResponseSchema.parse(await res.json())
    expect(body.current).toMatchObject({
      id: PRACTICE_ID,
      league: 'PRACTICE',
      status: 'live',
      homeScore: 30,
      awayScore: 33,
    })
    expect(body.nextAt).toBeGreaterThan(now)
    expect(body.counterparty).toBe('none')
    // Through the SDK client too.
    const client = new HoragonClient({
      baseUrl: 'http://horagon.test/api/v1',
      retries: 0,
      fetch: async (input, init) =>
        app.fetch(input instanceof Request ? input : new Request(input, init)),
    })
    expect((await client.practice()).current?.id).toBe(PRACTICE_ID)
  })

  it('has no current run once a run is long over, and no next tip-off from a stale process', async () => {
    await setFlag(env.h.db, 'FLAG_PRACTICE', true, 'test')
    await beat(
      'practice',
      { round: 9, nextAt: Math.floor(Date.now() / 1000) + 7_200, skipped: null },
      600,
    )
    await seedRun(now - 2 * 3600)
    const body = PracticeResponseSchema.parse(await (await get('/practice')).json())
    expect(body).toEqual({ current: null, nextAt: null, counterparty: 'none' })
  })
})

describe('the Practice view, pure', () => {
  const run = (tipOffset: number) =>
    ({ id: `practice-${tipOffset}`, scheduledTipoff: new Date((NOW + tipOffset) * 1000) }) as never

  it('takes the latest run from 15 min before its tip-off to 90 min after', () => {
    expect(currentPractice([run(-5_401)], NOW)).toBeNull()
    expect((currentPractice([run(-5_400)], NOW) as { id: string } | null)?.id).toBe(
      'practice--5400',
    )
    expect((currentPractice([run(900)], NOW) as { id: string } | null)?.id).toBe('practice-900')
    expect(currentPractice([run(901)], NOW)).toBeNull()
    expect((currentPractice([run(-3_000), run(600)], NOW) as { id: string } | null)?.id).toBe(
      'practice-600',
    )
  })

  it('names the agent only when its heartbeat is fresh, live and trading PRACTICE', () => {
    const hb = (info: Record<string, unknown>, age = 10) => ({
      ts: new Date((NOW - age) * 1000),
      info,
    })
    const live = { dryRun: false, practice: true }
    expect(counterpartyOf(hb(live), NOW)).toBe('agent')
    expect(counterpartyOf(hb(live, 121), NOW)).toBe('none')
    expect(counterpartyOf(hb({ ...live, dryRun: true }), NOW)).toBe('none')
    expect(counterpartyOf(hb({ ...live, practice: false }), NOW)).toBe('none')
    expect(counterpartyOf(hb({ dryRun: false }), NOW)).toBe('none')
    expect(counterpartyOf(hb({ ...live, paused: true }), NOW)).toBe('none')
    expect(counterpartyOf(hb({ ...live, stopped: true }), NOW)).toBe('none')
    expect(counterpartyOf(null, NOW)).toBe('none')
  })

  it('takes the next tip-off from a fresh Practice heartbeat only', () => {
    const hb = (nextAt: unknown, age = 10) => ({
      ts: new Date((NOW - age) * 1000),
      info: { nextAt },
    })
    expect(nextPracticeAt(hb(NOW + 600), NOW)).toBe(NOW + 600)
    expect(nextPracticeAt(hb(NOW + 600, 121), NOW)).toBeNull()
    expect(nextPracticeAt(hb(null), NOW)).toBeNull()
    expect(nextPracticeAt(hb('soon'), NOW)).toBeNull()
    expect(nextPracticeAt(hb(NOW - 1), NOW)).toBeNull()
    expect(nextPracticeAt(null, NOW)).toBeNull()
  })
})
