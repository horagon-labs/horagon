import {
  type DbHandle,
  getEvidence,
  heartbeat,
  putEvidence,
  upsertScheduledGames,
} from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildEvidence, sealEvidence } from '../src/evidence'
import { opsErrorReport } from '../src/ops/args'
import {
  type AttemptLookups,
  chooseEvidence,
  confirmedAtOf,
  EvidenceRefusal,
  endAttempt,
  type ProposeRecord,
  pendingAttempt,
  proposeRecordKey,
  readProposeRecord,
  startAttempt,
  writeProposeRecord,
} from '../src/ops/propose-evidence'

const ID = 'nba-401910007'
const game = { league: 'NBA', externalId: '401910007', home: 'CLE', away: 'MEM' }
const draft = {
  status: 'final',
  homeScore: 111,
  awayScore: 106,
  periods: [
    [30, 25],
    [28, 27],
    [26, 30],
    [27, 24],
  ] as Array<[number, number]>,
  sourceUrl:
    'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261118',
  fetchedAt: new Date('2026-11-19T02:20:00.250Z'),
}
const BOX = 'https://www.nba.com/game/mem-vs-cle-0022600234/box-score'
const FIRST = new Date('2026-11-19T02:31:09.900Z')
const RERUN = new Date('2026-11-19T02:34:41.000Z')

/** Seals the evidence of `d` confirmed by `url`, the way `propose` does. */
const sealer =
  (d: typeof draft = draft, url = BOX) =>
  (confirmedAt: Date) =>
    sealEvidence(
      buildEvidence({
        game,
        draft: d,
        kind: 0,
        confirmUrl: url,
        confirmSource: 'nba',
        confirmedAt,
      }),
    )

let h: DbHandle
beforeEach(async () => {
  h = await createTestDb()
  await upsertScheduledGames(h.db, [
    {
      id: ID,
      league: 'NBA',
      externalId: '401910007',
      gameDate: '2026-11-18',
      home: 'CLE',
      away: 'MEM',
      scheduledTipoff: new Date('2026-11-19T00:00:00Z'),
      status: 'final',
      p0: 0.62,
    },
  ])
})
afterEach(async () => {
  await h.close()
})

/** The first propose's evidence, stored as `propose` stores it. */
async function storeFirst() {
  const first = await sealer()(FIRST)
  await putEvidence(h.db, { gameId: ID, kind: 0, json: first.json, hash: first.hashHex })
  return first
}

const nothingPending = async () => null

describe('chooseEvidence', () => {
  it('seals now and writes when no evidence is stored', async () => {
    const choice = await chooseEvidence(h.db, {
      gameId: ID,
      seal: sealer(),
      now: FIRST,
      replace: false,
      pending: nothingPending,
    })
    expect(choice.write).toBe(true)
    expect(choice.sealed.evidence.sources[1]?.fetchedAt).toBe('2026-11-19T02:31:09Z')
  })

  it('reuses the stored row on a re-run with the same inputs: same hash, no write', async () => {
    const first = await storeFirst()
    let asked = 0
    const choice = await chooseEvidence(h.db, {
      gameId: ID,
      seal: sealer(),
      now: RERUN,
      replace: false,
      pending: async () => {
        asked++
        return 'never asked'
      },
    })
    expect(choice.write).toBe(false)
    expect(choice.sealed.hashHex).toBe(first.hashHex)
    expect(choice.sealed.json).toBe(first.json)
    expect(asked).toBe(0)
    expect(await getEvidence(h.db, ID, 0)).toEqual({ json: first.json, hash: first.hashHex })
  })

  it('refuses a re-run with changed inputs, exit 1, without --replace-evidence', async () => {
    const first = await storeFirst()
    const changed = [
      sealer({ ...draft, homeScore: 112, periods: [...draft.periods.slice(0, 3), [28, 24]] }),
      sealer(draft, 'https://www.basketball-reference.com/boxscores/202611180CLE.html'),
      sealer({ ...draft, fetchedAt: new Date('2026-11-19T02:25:00Z') }),
    ]
    for (const seal of changed) {
      const run = chooseEvidence(h.db, {
        gameId: ID,
        seal,
        now: RERUN,
        replace: false,
        pending: nothingPending,
      })
      await expect(run).rejects.toThrow(EvidenceRefusal)
      const err = await run.catch((e: unknown) => e)
      expect(String((err as Error).message)).toContain('may still land')
      expect(String((err as Error).message)).toContain('--replace-evidence')
      expect(opsErrorReport(err).exitCode).toBe(1)
    }
    expect((await getEvidence(h.db, ID, 0))?.hash).toBe(first.hashHex)
  })

  it('--replace-evidence overwrites only when no earlier attempt is pending', async () => {
    const first = await storeFirst()
    const seal = sealer({
      ...draft,
      homeScore: 112,
      periods: [...draft.periods.slice(0, 3), [28, 24]],
    })
    const refused = chooseEvidence(h.db, {
      gameId: ID,
      seal,
      now: RERUN,
      replace: true,
      pending: async () => '5sig may still land until block height 1200 (now 1100)',
    })
    await expect(refused).rejects.toThrow(/--replace-evidence refused: 5sig may still land/)
    expect((await getEvidence(h.db, ID, 0))?.hash).toBe(first.hashHex)

    const choice = await chooseEvidence(h.db, {
      gameId: ID,
      seal,
      now: RERUN,
      replace: true,
      pending: nothingPending,
    })
    expect(choice.write).toBe(true)
    expect(choice.sealed.hashHex).not.toBe(first.hashHex)
    expect(choice.sealed.evidence.homeScore).toBe(112)
  })

  it('treats stored evidence it cannot read back as sealed from other inputs', async () => {
    await putEvidence(h.db, { gameId: ID, kind: 0, json: '{"v":1', hash: 'ab'.repeat(32) })
    await expect(
      chooseEvidence(h.db, {
        gameId: ID,
        seal: sealer(),
        now: RERUN,
        replace: false,
        pending: nothingPending,
      }),
    ).rejects.toThrow(EvidenceRefusal)
  })
})

describe('confirmedAtOf', () => {
  it("reads the guardian's confirmation time, or null", async () => {
    const first = await sealer()(FIRST)
    expect(confirmedAtOf(first.json)?.toISOString()).toBe('2026-11-19T02:31:09.000Z')
    expect(confirmedAtOf('not json')).toBeNull()
    expect(confirmedAtOf('{"sources":[{}]}')).toBeNull()
    expect(confirmedAtOf('{"sources":[{},{"fetchedAt":"later"}]}')).toBeNull()
  })
})

describe('the propose record', () => {
  it('round-trips through keeper_heartbeats; a record that does not parse is unreadable', async () => {
    expect(await readProposeRecord(h.db, ID)).toBeNull()
    const { record, index } = startAttempt(null, 'aa', 0, 1_000)
    expect(index).toBe(0)
    await writeProposeRecord(h.db, ID, record)
    expect(await readProposeRecord(h.db, ID)).toEqual({
      hash: 'aa',
      round: 0,
      attempts: [{ at: 1_000, state: 'sending' }],
    })
    await heartbeat(h.db, proposeRecordKey(ID), { hash: 'aa' })
    expect(await readProposeRecord(h.db, ID)).toBe('unreadable')
  })

  it('appends attempts for the same evidence and round, and starts over otherwise', () => {
    const one = startAttempt(null, 'aa', 0, 1_000).record
    const ended = endAttempt(one, 0, {
      state: 'unresolved',
      sig: '5sig',
      ended: 1_090,
      height: 900,
    })
    expect(ended.attempts).toEqual([
      { at: 1_000, state: 'unresolved', sig: '5sig', ended: 1_090, height: 900 },
    ])
    const two = startAttempt(ended, 'aa', 0, 1_200)
    expect(two.index).toBe(1)
    expect(two.record.attempts).toHaveLength(2)
    expect(startAttempt(ended, 'bb', 0, 1_200).record.attempts).toEqual([
      { at: 1_200, state: 'sending' },
    ])
    expect(startAttempt(ended, 'aa', 1, 1_200).record).toEqual({
      hash: 'aa',
      round: 1,
      attempts: [{ at: 1_200, state: 'sending' }],
    })
    expect(startAttempt('unreadable', 'aa', 0, 1_200).index).toBe(0)
  })
})

describe('pendingAttempt', () => {
  const NOW = 10_000
  /** Chain lookups over a fixed status per signature and a fixed block height. */
  const chain = (
    statuses: Record<string, { err: unknown; confirmationStatus?: string } | null>,
    height = 1_000,
  ): AttemptLookups & { reads: string[] } => {
    const reads: string[] = []
    return {
      reads,
      async status(sig) {
        reads.push(sig)
        if (!(sig in statuses)) throw new Error('fetch failed')
        return statuses[sig] ?? null
      },
      async blockHeight() {
        return height
      },
    }
  }
  const record = (...attempts: ProposeRecord['attempts']): ProposeRecord => ({
    hash: 'aa',
    round: 1,
    attempts,
  })
  const unresolved = { at: NOW - 200, state: 'unresolved' as const, sig: '5sig', ended: NOW - 100 }

  it('finds nothing without a record, after a failed send, or in an earlier round', async () => {
    const c = chain({})
    expect(await pendingAttempt(null, 1, c, NOW)).toBeNull()
    expect(await pendingAttempt(record({ at: NOW - 5, state: 'failed' }), 1, c, NOW)).toBeNull()
    // Round 1 ended with its proposal challenged: nothing of it can land in round 2.
    expect(await pendingAttempt(record({ ...unresolved, height: 990 }), 2, c, NOW)).toBeNull()
    expect(c.reads).toEqual([])
  })

  it('refuses an unreadable record, a chain read behind it, and a landed attempt', async () => {
    const c = chain({})
    expect(await pendingAttempt('unreadable', 1, c, NOW)).toContain('does not parse')
    expect(await pendingAttempt(record(), 0, c, NOW)).toContain('chain read is behind')
    expect(
      await pendingAttempt(record({ at: NOW - 5, state: 'landed', sig: '5ok' }), 1, c, NOW),
    ).toBe('5ok landed: run status')
  })

  it('waits on an unresolved attempt until its block height has passed', async () => {
    const seen = chain({ '5sig': null }, 1_000)
    expect(await pendingAttempt(record({ ...unresolved, height: 900 }), 1, seen, NOW)).toBe(
      '5sig may still land until block height 1100 (now 1000)',
    )
    expect(await pendingAttempt(record({ ...unresolved, height: 799 }), 1, seen, NOW)).toBeNull()
  })

  it('asks the chain about the signature first', async () => {
    const attempt = record({ ...unresolved, height: 100 })
    expect(
      await pendingAttempt(
        attempt,
        1,
        chain({ '5sig': { err: null, confirmationStatus: 'confirmed' } }),
        NOW,
      ),
    ).toBe('5sig landed: run status')
    expect(
      await pendingAttempt(
        attempt,
        1,
        chain({ '5sig': { err: null, confirmationStatus: 'processed' } }),
        NOW,
      ),
    ).toBe('5sig is processed and may still land')
    expect(
      await pendingAttempt(
        attempt,
        1,
        chain({
          '5sig': {
            err: { InstructionError: [2, { Custom: 6000 }] },
            confirmationStatus: 'confirmed',
          },
        }),
        NOW,
      ),
    ).toBeNull()
    // An unreadable status is unknown, never "expired".
    expect(await pendingAttempt(attempt, 1, chain({}), NOW)).toMatch(
      /^cannot read the status of 5sig/,
    )
  })

  it('falls back to time without a height, and waits 15 min on a send that never ended', async () => {
    const c = chain({ '5sig': null })
    expect(await pendingAttempt(record({ ...unresolved, ended: NOW - 299 }), 1, c, NOW)).toContain(
      'may still land until',
    )
    expect(await pendingAttempt(record({ ...unresolved, ended: NOW - 300 }), 1, c, NOW)).toBeNull()
    const sending = (at: number) => record({ at, state: 'sending' })
    expect(await pendingAttempt(sending(NOW - 899), 1, c, NOW)).toContain('never recorded its end')
    expect(await pendingAttempt(sending(NOW - 900), 1, c, NOW)).toBeNull()
  })

  it('checks every attempt: one still pending is enough', async () => {
    const c = chain({
      '5old': null,
      '5new': { err: { InstructionError: [2, 'x'] }, confirmationStatus: 'finalized' },
    })
    const both = record(
      { at: NOW - 200, state: 'unresolved', sig: '5old', ended: NOW - 100, height: 950 },
      { at: NOW - 50, state: 'failed' },
      { at: NOW - 40, state: 'unresolved', sig: '5new', ended: NOW - 10, height: 990 },
    )
    expect(await pendingAttempt(both, 1, c, NOW)).toContain('5old may still land')
  })
})
