import {
  type DbHandle,
  getDraft,
  getEvidence,
  heartbeat,
  putEvidence,
  upsertDraft,
  upsertScheduledGames,
} from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildEvidence, sealEvidence } from '../src/evidence'
import { opsErrorReport } from '../src/ops/args'
import {
  type AttemptLookups,
  chooseAndStoreEvidence,
  chooseEvidence,
  confirmedAtOf,
  EvidenceRefusal,
  endAttempt,
  nextDraft,
  type ProposeRecord,
  pendingAttempt,
  proposeRecordKey,
  proposeStatusLine,
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

  it('finds nothing without a record or after a failed send', async () => {
    const c = chain({})
    expect(await pendingAttempt(null, 1, c, NOW)).toBeNull()
    expect(await pendingAttempt(record({ at: NOW - 5, state: 'failed' }), 1, c, NOW)).toBeNull()
    expect(c.reads).toEqual([])
  })

  it('in an earlier round, still waits on an attempt that may land, but not on one that did', async () => {
    // The program takes a propose from Challenged with no round: a round-1 attempt whose
    // blockhash is still valid can land after the challenge.
    const seen = chain({ '5sig': null }, 1_000)
    expect(await pendingAttempt(record({ ...unresolved, height: 990 }), 2, seen, NOW)).toBe(
      '5sig may still land until block height 1190 (now 1000)',
    )
    expect(await pendingAttempt(record({ ...unresolved, height: 790 }), 2, seen, NOW)).toBeNull()
    const sending = record({ at: NOW - 5, state: 'sending' })
    expect(await pendingAttempt(sending, 2, seen, NOW)).toContain('never recorded its end')
    // Landed in round 1 and challenged since: expected, not a reason to wait.
    const landed = record({ at: NOW - 5, state: 'landed', sig: '5ok' })
    expect(await pendingAttempt(landed, 2, seen, NOW)).toBeNull()
    const confirmed = chain({ '5sig': { err: null, confirmationStatus: 'confirmed' } })
    expect(
      await pendingAttempt(record({ ...unresolved, height: 990 }), 2, confirmed, NOW),
    ).toBeNull()
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

describe('proposeStatusLine', () => {
  const NOW = 10_000
  const chain = (
    status: { err: unknown; confirmationStatus?: string } | null = null,
    height = 1_000,
  ): AttemptLookups => ({
    status: async () => status,
    blockHeight: async () => height,
  })
  const record = (...attempts: ProposeRecord['attempts']): ProposeRecord => ({
    hash: 'aa',
    round: 1,
    attempts,
  })
  const SIG = '5Zq8KJ2vXn3mP7wYtR4cLbH9dFgAeUoS6iNxVjMkQhTy'
  const SHORT = '5Zq8KJ2v...QhTy'
  const sentAt900 = record({
    at: NOW - 200,
    state: 'unresolved',
    sig: SIG,
    ended: NOW - 100,
    height: 900,
  })

  it('prints nothing without a record', async () => {
    expect(await proposeStatusLine(null, 1, chain(), NOW)).toBeNull()
  })

  it('sending: the send never ended, so it may still land; after 15 min it is expired', async () => {
    const line = await proposeStatusLine(
      record({ at: NOW - 60, state: 'sending' }),
      1,
      chain(),
      NOW,
    )
    expect(line).toBe(
      '  propose attempt: sending  sig none  round 1  pending check: may still land',
    )
    const old = await proposeStatusLine(
      record({ at: NOW - 901, state: 'sending' }),
      1,
      chain(),
      NOW,
    )
    expect(old).toBe('  propose attempt: sending  sig none  round 1  pending check: expired')
  })

  it('sent: may still land until its height has passed, then expired', async () => {
    expect(await proposeStatusLine(sentAt900, 1, chain(null, 1_000), NOW)).toBe(
      `  propose attempt: sent  sig ${SHORT}  round 1  pending check: may still land`,
    )
    expect(await proposeStatusLine(sentAt900, 1, chain(null, 1_101), NOW)).toBe(
      `  propose attempt: sent  sig ${SHORT}  round 1  pending check: expired`,
    )
  })

  it('sent and found on chain: landed', async () => {
    const line = await proposeStatusLine(
      sentAt900,
      1,
      chain({ err: null, confirmationStatus: 'finalized' }),
      NOW,
    )
    expect(line).toBe(`  propose attempt: sent  sig ${SHORT}  round 1  pending check: landed`)
  })

  it('ended: landed, or failed (nothing can land)', async () => {
    const landed = record({ at: NOW - 5, state: 'landed', sig: SIG })
    expect(await proposeStatusLine(landed, 1, chain(), NOW)).toBe(
      `  propose attempt: ended  sig ${SHORT}  round 1  pending check: landed`,
    )
    const failed = record({ at: NOW - 5, state: 'failed' })
    expect(await proposeStatusLine(failed, 1, chain(), NOW)).toBe(
      '  propose attempt: ended  sig none  round 1  pending check: expired',
    )
  })

  it('never prints a full signature, and agrees with pendingAttempt', async () => {
    for (const height of [1_000, 1_101]) {
      const c = chain(null, height)
      const line = await proposeStatusLine(sentAt900, 1, c, NOW)
      expect(line).not.toContain(SIG)
      const expired = (await pendingAttempt(sentAt900, 1, c, NOW)) === null
      expect(line?.endsWith(expired ? 'expired' : 'may still land')).toBe(true)
    }
  })

  it('an unreadable record may still land', async () => {
    expect(await proposeStatusLine('unreadable', 1, chain(), NOW)).toBe(
      '  propose record: unreadable  pending check: may still land',
    )
  })
})

describe('chooseAndStoreEvidence', () => {
  const row = { gameId: ID, ...draft }
  const changedDraft = {
    ...draft,
    periods: [draft.periods[1], draft.periods[0], ...draft.periods.slice(2)] as Array<
      [number, number]
    >,
    fetchedAt: new Date('2026-11-19T02:40:00.000Z'),
  }
  const changedRow = { gameId: ID, ...changedDraft }
  const args = (newDraft: typeof row | null, d: typeof draft) => ({
    gameId: ID,
    newDraft,
    seal: sealer(d),
    now: RERUN,
    replace: false,
    pending: nothingPending,
  })

  it('writes the evidence, then the draft, when accepted', async () => {
    const choice = await chooseAndStoreEvidence(h.db, args(row, draft))
    expect(choice.write).toBe(true)
    expect(await getEvidence(h.db, ID, 0)).toEqual({
      json: choice.sealed.json,
      hash: choice.sealed.hashHex,
    })
    expect((await getDraft(h.db, ID))?.fetchedAt).toEqual(draft.fetchedAt)
  })

  it('a refused run with changed inputs leaves the draft row as it was, fetchedAt included', async () => {
    await upsertDraft(h.db, row)
    const first = await storeFirst()
    const before = await getDraft(h.db, ID)
    await expect(
      chooseAndStoreEvidence(h.db, args(changedRow, changedDraft)),
    ).rejects.toBeInstanceOf(EvidenceRefusal)
    expect(await getDraft(h.db, ID)).toEqual(before)
    expect(await getEvidence(h.db, ID, 0)).toEqual({ json: first.json, hash: first.hashHex })
  })

  it('after a refused run, a re-run with the original inputs reuses the stored evidence: same hash, no write', async () => {
    await upsertDraft(h.db, row)
    const first = await storeFirst()
    await expect(
      chooseAndStoreEvidence(h.db, args(changedRow, changedDraft)),
    ).rejects.toBeInstanceOf(EvidenceRefusal)
    const stored = await getDraft(h.db, ID)
    if (!stored) throw new Error('draft lost')
    // The original inputs: the stored draft, used as it is (no new draft to write).
    const again = await chooseAndStoreEvidence(h.db, args(null, stored))
    expect(again.write).toBe(false)
    expect(again.sealed.hashHex).toBe(first.hashHex)
    expect(again.sealed.json).toBe(first.json)
    expect(await getDraft(h.db, ID)).toEqual(stored)
  })

  it('--replace-evidence writes the evidence and the new draft once nothing is pending', async () => {
    await upsertDraft(h.db, row)
    await storeFirst()
    const choice = await chooseAndStoreEvidence(h.db, {
      ...args(changedRow, changedDraft),
      replace: true,
    })
    expect(choice.write).toBe(true)
    expect((await getDraft(h.db, ID))?.fetchedAt).toEqual(changedDraft.fetchedAt)
    expect((await getEvidence(h.db, ID, 0))?.hash).toBe(choice.sealed.hashHex)
  })
})

describe('chooseAndStoreEvidence transaction', () => {
  const row = { gameId: ID, ...draft }
  const base = {
    gameId: ID,
    seal: sealer(),
    now: RERUN,
    replace: false,
    pending: nothingPending,
  }
  const record = (hash: string): ProposeRecord => ({
    hash,
    round: 0,
    attempts: [{ at: 1, state: 'sending' }],
  })

  it('commits the evidence, the draft and the propose record together', async () => {
    const choice = await chooseAndStoreEvidence(h.db, {
      ...base,
      newDraft: row,
      record: (s) => record(s.hashHex),
    })
    expect((await getEvidence(h.db, ID, 0))?.hash).toBe(choice.sealed.hashHex)
    expect(await getDraft(h.db, ID)).not.toBeNull()
    expect(await readProposeRecord(h.db, ID)).toEqual(record(choice.sealed.hashHex))
  })

  it('a failing draft write rolls the evidence and the record back', async () => {
    // A draft for a game that does not exist breaks the foreign key after the evidence is in.
    await expect(
      chooseAndStoreEvidence(h.db, {
        ...base,
        newDraft: { ...row, gameId: 'nba-000000000' },
        record: (s) => record(s.hashHex),
      }),
    ).rejects.toThrow()
    expect(await getEvidence(h.db, ID, 0)).toBeNull()
    expect(await getDraft(h.db, ID)).toBeNull()
    expect(await readProposeRecord(h.db, ID)).toBeNull()
  })

  it('a failing record write rolls the evidence and the draft back', async () => {
    await expect(
      chooseAndStoreEvidence(h.db, {
        ...base,
        newDraft: row,
        // Not a JSON-able record: the heartbeat write throws.
        record: () => ({ hash: 'aa', round: 0, attempts: [], bad: 1n }) as unknown as ProposeRecord,
      }),
    ).rejects.toThrow()
    expect(await getEvidence(h.db, ID, 0)).toBeNull()
    expect(await getDraft(h.db, ID)).toBeNull()
    expect(await readProposeRecord(h.db, ID)).toBeNull()
  })
})

describe('nextDraft', () => {
  const NOW = new Date('2026-11-19T03:00:00.000Z')
  const stored = (over: Record<string, unknown> = {}) =>
    ({
      gameId: ID,
      ...draft,
      state: 'pending',
      alertedAt: null,
      createdAt: new Date('2026-11-19T02:20:00Z'),
      ...over,
    }) as unknown as NonNullable<Awaited<ReturnType<typeof getDraft>>>
  const finalWish = (over: Record<string, unknown> = {}) =>
    ({
      gameId: ID,
      status: 'final' as const,
      home: 111,
      away: 106,
      periods: null,
      sourceUrl: BOX,
      ...over,
    }) as Parameters<typeof nextDraft>[1]
  const postponed = {
    gameId: ID,
    status: 'postponed' as const,
    notice: 'https://www.nba.com/news/postponed',
  }

  it('refuses a proposed draft for --postponed and for --periods', () => {
    const proposed = stored({ state: 'proposed' })
    expect(() => nextDraft(proposed, postponed, NOW)).toThrow(
      `${ID}: no pending postponed draft to propose; run status`,
    )
    expect(() => nextDraft(proposed, finalWish({ periods: draft.periods }), NOW)).toThrow(
      `${ID}: no pending final draft to propose; run status`,
    )
    expect(() => nextDraft(proposed, finalWish(), NOW)).toThrow('no pending final draft')
  })

  it('postponed: keeps a pending postponed draft, otherwise writes the notice as the draft', () => {
    const keeper = stored({ status: 'postponed', homeScore: 0, awayScore: 0, periods: [] })
    expect(nextDraft(keeper, postponed, NOW)).toEqual({ draft: keeper, newDraft: null })
    for (const prior of [null, stored()]) {
      const next = nextDraft(prior, postponed, NOW)
      expect(next.newDraft).toEqual({
        gameId: ID,
        status: 'postponed',
        homeScore: 0,
        awayScore: 0,
        periods: [],
        sourceUrl: postponed.notice,
        fetchedAt: NOW,
      })
      expect(next.draft).toBe(next.newDraft)
    }
  })

  it('--periods: the same reading reuses the stored draft and its time, a new one is a new draft', () => {
    const prior = stored({ sourceUrl: BOX })
    const same = nextDraft(prior, finalWish({ periods: draft.periods }), NOW)
    expect(same).toEqual({ draft: prior, newDraft: null })
    const other = [draft.periods[1], draft.periods[0], ...draft.periods.slice(2)] as Array<
      [number, number]
    >
    const newer = nextDraft(prior, finalWish({ periods: other }), NOW)
    expect(newer.newDraft).toMatchObject({
      gameId: ID,
      status: 'final',
      periods: other,
      fetchedAt: NOW,
    })
    // Another URL, other scores, no draft, or a postponed one: all a new draft.
    expect(
      nextDraft(prior, finalWish({ periods: draft.periods, sourceUrl: `${BOX}?x` }), NOW).newDraft,
    ).not.toBeNull()
    expect(nextDraft(null, finalWish({ periods: draft.periods }), NOW).newDraft).not.toBeNull()
    expect(
      nextDraft(stored({ status: 'postponed' }), finalWish({ periods: draft.periods }), NOW)
        .newDraft,
    ).not.toBeNull()
  })

  it('without --periods: uses the pending final draft, or says there is none', () => {
    const prior = stored()
    expect(nextDraft(prior, finalWish(), NOW)).toEqual({ draft: prior, newDraft: null })
    for (const bad of [null, stored({ status: 'postponed' })]) {
      expect(() => nextDraft(bad, finalWish(), NOW)).toThrow(`${ID}: no pending draft (keeper`)
    }
  })

  it('refuses a box score that differs from the draft in use', () => {
    expect(() => nextDraft(stored(), finalWish({ home: 110 }), NOW)).toThrow(
      'box score 110-106 differs from the draft 111-106: halt, check, then pass --periods',
    )
    // A new draft is built from the same scores, so --periods fixes it by being consistent.
    expect(
      nextDraft(stored(), finalWish({ home: 110, periods: draft.periods }), NOW).newDraft,
    ).not.toBeNull()
  })
})
