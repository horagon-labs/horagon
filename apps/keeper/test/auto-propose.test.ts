import {
  type DbHandle,
  getDraft,
  getEvidence,
  getGame,
  listOps,
  setDraftState,
  updateMarket,
  upsertDraft,
} from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import { parseResolutionEvidence } from '@horagon/sdk'
import { Keypair } from '@solana/web3.js'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProgramFailure } from '../src/executor'
import type { Feed, FeedGame } from '../src/feeds/types'
import { readProposeRecord } from '../src/ops/propose-evidence'
import { DEFAULT_SEEDS, DEFAULT_TIMINGS } from '../src/planner'
import { evidenceUri, proposeResult } from '../src/propose'
import { Balldontlie } from '../src/second-source/balldontlie'
import {
  autoProposedText,
  autoProposeNotices,
  boxScoreLink,
  draftText,
  heldText,
  Keeper,
  type KeeperDeps,
  mismatchText,
  utcAndEt,
} from '../src/tick'
import {
  chainHash,
  DRAFT,
  END,
  FakeChain,
  ID,
  program,
  proposeArgs,
  QUARTERS,
  S,
  STATUS,
  seedGame,
  seedMarket,
} from './chain-fixtures'

const attestor = Keypair.generate()
const URI = `https://www.horagon.xyz/api/v1/evidence/${ID}/winner`
const BOX = 'https://www.basketball-reference.com/boxscores/202611180CLE.html'
const BDL_KEY = 'x'.repeat(16)

interface LogLine {
  level: number
  msg: string
  [k: string]: unknown
}

let h: DbHandle
let chain: FakeChain
let now: number
let current: FeedGame
let alerts: Array<[string, string]>
let logs: LogLine[]
/** balldontlie's answer for 2026-11-18, and every date it was asked for. */
let bdl: { status: string; home: number; away: number } | 'none' | 'down' | 'refused'
let bdlAsked: string[]

const final: FeedGame = {
  league: 'NBA',
  externalId: '401910007',
  gameDate: '2026-11-18',
  home: 'CLE',
  away: 'MEM',
  tipoff: new Date(S * 1000),
  status: 'final',
  period: 4,
  clockSecs: null,
  homeScore: 111,
  awayScore: 106,
  periods: QUARTERS,
  cup: false,
}

const feed: Feed = {
  name: 'fake',
  async fetchDay(date) {
    return {
      source: 'espn',
      url: `https://site.api.espn.com/scoreboard?dates=${date}`,
      fetchedAt: new Date(now * 1000),
      games: date === current.gameDate ? [current] : [],
    }
  },
}

const fakeFetch = (async (input: URL) => {
  const date = input.searchParams.get('dates[]') ?? ''
  bdlAsked.push(date)
  if (bdl === 'down') return new Response('', { status: 503 })
  if (bdl === 'refused') return new Response('', { status: 401 })
  const games =
    bdl === 'none' || date !== '2026-11-18'
      ? []
      : [
          {
            id: 9001,
            date,
            status: bdl.status,
            period: 4,
            home_team_score: bdl.home,
            visitor_team_score: bdl.away,
            home_team: { id: 6, abbreviation: 'CLE' },
            visitor_team: { id: 15, abbreviation: 'MEM' },
          },
        ]
  return Response.json({ data: games, meta: {} })
}) as unknown as typeof fetch

function keeperWith(over: Partial<KeeperDeps> = {}): Keeper {
  const deps: KeeperDeps = {
    db: h.db,
    sender: chain.sender,
    program,
    attestor,
    feed,
    alerts: { send: async (k, t) => void alerts.push([k, t]) },
    log: pino({ level: 'info' }, { write: (line: string) => void logs.push(JSON.parse(line)) }),
    now: () => now,
    timings: DEFAULT_TIMINGS,
    seeds: DEFAULT_SEEDS,
    sigma: 13,
    priority: { normal: 10_000, halt: 200_000 },
    feedEverySecs: 0,
    autoPropose: {
      mode: 'on',
      evidenceUri: (id) => evidenceUri('https://www.horagon.xyz', 'devnet', id),
      secondSource: new Balldontlie(BDL_KEY, fakeFetch),
    },
    ...over,
  }
  return new Keeper(deps)
}

/** A tick at `t`, with the chain clock at the same time. */
async function at(k: Keeper, t: number): Promise<string[]> {
  now = t
  chain.clock = t
  return (await k.tick()).map((a) => a.type)
}

const keys = () => alerts.map(([k]) => k)

beforeEach(async () => {
  h = await createTestDb()
  await seedGame(h.db)
  const marketId = await seedMarket(h.db)
  chain = new FakeChain(marketId, attestor.publicKey, END - 960)
  chain.setMarket(STATUS.halted)
  current = final
  alerts = []
  logs = []
  bdl = { status: 'Final', home: 111, away: 106 }
  bdlAsked = []
})
afterEach(async () => {
  await h.close()
  expect(chain.doneProblems).toEqual([])
})

/** The buzzer halt drafted: Final read at END - 960, drafted at END - 900. */
async function drafted(k: Keeper): Promise<void> {
  expect(await at(k, END - 960)).toEqual([])
  expect(await at(k, END - 900)).toEqual(['draft'])
}

describe('the keeper proposes, checks and pages', () => {
  it('proposes a checked Final at end_ts, then finalizes and recycles it (item 7)', async () => {
    const k = keeperWith()
    await drafted(k)
    // Nothing asked of balldontlie before there was a draft to check.
    expect(bdlAsked).toEqual([])
    expect(alerts.at(-1)).toEqual([
      `draft:${ID}:0`,
      `MEM@CLE Final 106-111 (ESPN). Auto-propose from ${utcAndEt(END)}, second source balldontlie. Nothing to do unless paged.`,
    ])
    // The check: one request a minute for the date, however often the keeper ticks.
    for (let t = END - 840; t < END - 780; t += 5) expect(await at(k, t)).toEqual([])
    expect(bdlAsked).toEqual(['2026-11-18'])
    // A match is final: balldontlie is not asked again.
    expect(await at(k, END - 600)).toEqual([])
    expect(bdlAsked).toHaveLength(1)
    const checked = (await listOps(h.db)).filter((o) => o.action === 'second-source')
    expect(checked).toHaveLength(1)
    expect(checked[0]).toMatchObject({ actor: 'keeper', gameId: ID })
    expect(checked[0]?.detail).toMatchObject({ verdict: 'match', draft: '111-106' })

    expect(await at(k, END - 1)).toEqual([])
    expect(chain.sends).toEqual([])
    expect(await at(k, END)).toEqual(['propose'])
    expect(chain.sends).toEqual([`propose ${ID}`])
    const sent = proposeArgs(chain.specs[0] ?? (undefined as never))
    expect(sent.signer.equals(attestor.publicKey)).toBe(true)
    expect(sent.uri).toBe(URI)
    const stored = await getEvidence(h.db, ID, 0)
    expect(stored?.hash).toBe(chainHash(chain))
    const ev = parseResolutionEvidence(JSON.parse(stored?.json ?? '{}'))
    expect(ev.sources.map((s) => [s.name, s.url, s.fetchedAt])).toEqual([
      ['espn', 'https://site.api.espn.com/scoreboard?dates=2026-11-18', '2026-11-18T13:50:40Z'],
      ['balldontlie', 'https://api.balldontlie.io/v1/games/9001', '2026-11-18T13:52:40Z'],
    ])
    // Synced at once: the row is proposed with its time, and the evidence check found no gap.
    const row = (await getGame(h.db, ID))?.markets[0]
    expect(row).toMatchObject({ status: 'proposed', proposedAt: new Date(END * 1000) })
    expect((await getDraft(h.db, ID))?.state).toBe('proposed')
    const short = `${stored?.hash.slice(0, 8)}...${stored?.hash.slice(-4)}`
    expect(alerts.at(-1)).toEqual([
      `auto-proposed:${ID}:0`,
      `Proposed YES for MEM@CLE, Final 106-111 (ESPN). ESPN and balldontlie agree. Nothing to do. The challenge window closes at ${utcAndEt(END + 900)}. sha256 ${short}. If wrong: horagon-ops challenge ${ID}`,
    ])
    expect(keys()).not.toContain(`evidence-mismatch:${ID}`)
    expect((await listOps(h.db)).find((o) => o.action === 'propose')?.actor).toBe('keeper')

    // Item 7: the window closes, the keeper finalizes, then recycles.
    expect(await at(k, END + 899)).toEqual([])
    expect(await at(k, END + 900)).toEqual(['finalize'])
    expect(await at(k, END + 905)).toEqual(['recycle'])
    expect(chain.sends).toEqual([`propose ${ID}`, `finalize ${ID}`, `recycle ${ID}`])
    expect((await getGame(h.db, ID))?.markets[0]).toMatchObject({ status: 'recycled' })
    expect(keys().filter((key) => key.startsWith('unconfirmed'))).toEqual([])
    // The proposal was paged once.
    expect(keys().filter((key) => key.startsWith('auto-proposed'))).toEqual([
      `auto-proposed:${ID}:0`,
    ])
  })

  it('sends the proposal page again until it is delivered', async () => {
    let refused = 2
    const k = keeperWith({
      alerts: {
        send: async (key, text) => {
          alerts.push([key, text])
          if (!key.startsWith('auto-proposed') || refused === 0) return true
          refused--
          return false
        },
      },
    })
    await drafted(k)
    await at(k, END - 840)
    expect(await at(k, END)).toEqual(['propose'])
    expect(await at(k, END + 5)).toEqual(['announce'])
    expect(await at(k, END + 60)).toEqual(['announce'])
    expect(await at(k, END + 65)).toEqual([])
    const pages = alerts.filter(([key]) => key === `auto-proposed:${ID}:0`)
    expect(pages).toHaveLength(3)
    expect(new Set(pages.map(([, text]) => text)).size).toBe(1)
    expect(pages[0]?.[1]).toContain(`closes at ${utcAndEt(END + 900)}`)
    expect(chain.sends).toEqual([`propose ${ID}`])
  })

  it('pages a proposal whose page or writes after landing failed, on a later tick', async () => {
    let broken = true
    const k = keeperWith({
      autoPropose: {
        mode: 'on',
        evidenceUri: (id) => evidenceUri('https://www.horagon.xyz', 'devnet', id),
        secondSource: null,
      },
      alerts: {
        send: async (key, text) => {
          if (key.startsWith('auto-proposed') && broken) throw new Error('page lost')
          alerts.push([key, text])
        },
      },
    })
    await drafted(k)
    expect(await at(k, END)).toEqual(['propose'])
    expect(keys().filter((key) => key.startsWith('auto-proposed'))).toEqual([])
    broken = false
    expect(await at(k, END + 5)).toEqual(['announce'])
    expect(alerts.at(-1)).toEqual([
      `auto-proposed:${ID}:0`,
      `CHECK: proposed YES for MEM@CLE, Final 106-111 (ESPN), with no second source: BALLDONTLIE_API_KEY is not set. Check the box score: ${BOX}. If wrong, challenge before ${utcAndEt(END + 900)}: horagon-ops challenge ${ID}`,
    ])
    expect(await at(k, END + 10)).toEqual([])

    // The writes after landing failed (the draft still pending, the row still halted), then the
    // keeper restarted: it syncs the row, marks the draft proposed and pages the proposal again.
    await setDraftState(h.db, ID, { state: 'pending' })
    const pubkey = (await getGame(h.db, ID))?.markets[0]?.pubkey ?? ''
    await updateMarket(h.db, pubkey, { status: 'halted', proposedAt: null })
    const again = keeperWith({
      autoPropose: {
        mode: 'on',
        evidenceUri: (id) => evidenceUri('https://www.horagon.xyz', 'devnet', id),
        secondSource: null,
      },
    })
    expect(await at(again, END + 30)).toEqual(['sync', 'announce'])
    expect((await getDraft(h.db, ID))?.state).toBe('proposed')
    expect((await getGame(h.db, ID))?.markets[0]).toMatchObject({ status: 'proposed' })
    expect(alerts.filter(([key]) => key === `auto-proposed:${ID}:0`)).toHaveLength(2)
    expect(await at(again, END + 35)).toEqual([])
    expect(chain.sends).toEqual([`propose ${ID}`])
  })

  it('without a balldontlie key, proposes unchecked and pages CHECK', async () => {
    const k = keeperWith({
      autoPropose: {
        mode: 'on',
        evidenceUri: (id) => evidenceUri('https://www.horagon.xyz', 'devnet', id),
        secondSource: null,
      },
    })
    await drafted(k)
    expect(alerts.at(-1)?.[1]).toContain('second source off')
    expect(await at(k, END)).toEqual(['propose'])
    const ev = parseResolutionEvidence(JSON.parse((await getEvidence(h.db, ID, 0))?.json ?? '{}'))
    expect(ev.sources.map((s) => s.name)).toEqual(['espn'])
    expect(alerts.at(-1)).toEqual([
      `auto-proposed:${ID}:0`,
      `CHECK: proposed YES for MEM@CLE, Final 106-111 (ESPN), with no second source: BALLDONTLIE_API_KEY is not set. Check the box score: ${BOX}. If wrong, challenge before ${utcAndEt(END + 900)}: horagon-ops challenge ${ID}`,
    ])
  })

  it('waits 600 s for a silent balldontlie, then proposes unchecked', async () => {
    bdl = 'down'
    const k = keeperWith()
    await drafted(k)
    expect(await at(k, END - 840)).toEqual([])
    expect(logs.some((l) => l.msg === 'second source read failed')).toBe(true)
    expect(JSON.stringify(logs)).not.toContain(BDL_KEY)
    bdl = { status: '4th Qtr', home: 100, away: 98 }
    expect(await at(k, END + 599)).toEqual([])
    expect(await at(k, END + 600)).toEqual(['propose'])
    expect(alerts.at(-1)?.[1]).toBe(
      `CHECK: proposed YES for MEM@CLE, Final 106-111 (ESPN), with no second source: balldontlie had no final score 10 min after proposing opened. Check the box score: ${BOX}. If wrong, challenge before ${utcAndEt(END + 1_500)}: horagon-ops challenge ${ID}`,
    )
    // Still inside the window, balldontlie answers a different final: a guardian is paged.
    bdl = { status: 'Final', home: 110, away: 106 }
    expect(await at(k, END + 700)).toEqual(['mismatch'])
    expect(alerts.at(-1)).toEqual([
      `source-mismatch:${ID}`,
      `MISMATCH: MEM@CLE balldontlie 106-110 vs proposed 106-111. Challenge before ${utcAndEt(END + 1_500)}: horagon-ops challenge ${ID}, then runbook C.`,
    ])
    // It keeps paging (the alerter's window spaces it) until the window closes.
    expect(await at(k, END + 760)).toEqual(['mismatch'])
    expect(await at(k, END + 1_500)).toEqual(['finalize'])
  })

  it('holds a draft balldontlie contradicts, then reminds with the cause', async () => {
    bdl = { status: 'Final', home: 110, away: 106 }
    const k = keeperWith()
    await drafted(k)
    expect(await at(k, END - 840)).toEqual([])
    expect(await at(k, END)).toEqual(['hold'])
    expect(chain.sends).toEqual([])
    expect(alerts.at(-1)).toEqual([
      `source-held:${ID}`,
      `HELD: MEM@CLE ESPN 106-111 vs balldontlie 106-110, nothing proposed. Check the box score (${BOX}), then: horagon-ops propose ${ID} --box-score <url> --score <h>-<a> [--periods ...]`,
    ])
    expect(await at(k, END + 1_800)).toEqual(['hold', 'alert'])
    expect(alerts.at(-1)).toEqual([
      `unconfirmed:${ID}:0`,
      `MEM@CLE: final draft not proposed 30 min after proposing opened: held: ESPN 106-111 vs balldontlie 106-110. Propose by hand: horagon-ops propose ${ID} --box-score <url> --score 111-106`,
    ])
    // balldontlie corrects itself: the sources agree and the keeper proposes.
    bdl = { status: 'Final', home: 111, away: 106 }
    expect(await at(k, END + 1_860)).toEqual(['propose'])
    expect(chain.sends).toEqual([`propose ${ID}`])
  })

  it('pages a guardian when balldontlie refuses the key, without the key', async () => {
    bdl = 'refused'
    const k = keeperWith()
    await drafted(k)
    expect(await at(k, END - 840)).toEqual([])
    expect(alerts.at(-1)).toEqual([
      'second-source-refused',
      'balldontlie refused BALLDONTLIE_API_KEY (HTTP 401): it checks no result until the key in .env.keeper is fixed and the keeper restarted, so every proposal pages CHECK',
    ])
    expect(JSON.stringify([alerts, logs])).not.toContain(BDL_KEY)
    // A failure that is not a refusal pages nothing.
    bdl = 'down'
    alerts = []
    expect(await at(k, END - 780)).toEqual([])
    expect(alerts).toEqual([])
  })

  it('keeps holding when balldontlie stops reporting the game, and after a restart', async () => {
    bdl = { status: 'Final', home: 110, away: 106 }
    const k = keeperWith()
    await drafted(k)
    expect(await at(k, END - 840)).toEqual([])
    expect(await at(k, END)).toEqual(['hold'])
    // balldontlie no longer lists the game, then is down: silence is no agreement.
    bdl = 'none'
    expect(await at(k, END + 300)).toEqual(['hold'])
    expect(await at(k, END + 660)).toEqual(['hold'])
    bdl = 'down'
    expect(await at(k, END + 1_300)).toEqual(['hold'])
    expect(chain.sends).toEqual([])
    // A restart forgets the checks in memory, not the hold: balldontlie stays down past the wait.
    // It reads the Final anew (held 60 s from END + 1,310), then holds past the 600 s wait.
    const again = keeperWith()
    expect(await at(again, END + 1_310)).toEqual([])
    expect(await at(again, END + 1_370)).toEqual(['hold'])
    expect(await at(again, END + 2_000)).toEqual(['hold', 'alert'])
    expect(alerts.at(-1)?.[1]).toContain('held: ESPN 106-111 vs balldontlie 106-110')
    expect(chain.sends).toEqual([])
    expect(keys().filter((key) => key.startsWith('auto-proposed'))).toEqual([])
    // Only an answer that agrees with the draft ends the hold.
    bdl = { status: 'Final', home: 111, away: 106 }
    expect(await at(again, END + 2_060)).toEqual(['propose'])
    expect(chain.sends).toEqual([`propose ${ID}`])
  })

  it('a dry run pages once, and sends and writes nothing', async () => {
    const k = keeperWith({
      autoPropose: {
        mode: 'dry',
        evidenceUri: (id) => evidenceUri('https://www.horagon.xyz', 'devnet', id),
        secondSource: new Balldontlie(BDL_KEY, fakeFetch),
      },
    })
    await drafted(k)
    // The draft page is the manual one: nothing will be proposed by the keeper.
    expect(alerts.at(-1)?.[1]).toBe(
      draftText(
        { id: ID, away: 'MEM', home: 'CLE' },
        { status: 'final', homeScore: 111, awayScore: 106 },
        END,
        END - 900,
      ),
    )
    expect(await at(k, END - 840)).toEqual([])
    expect(await at(k, END)).toEqual(['propose'])
    expect(await at(k, END + 5)).toEqual(['propose'])
    const dry = alerts.filter(([key]) => key === `auto-proposed:${ID}:0`)
    expect(dry).toEqual([
      [
        `auto-proposed:${ID}:0`,
        `DRY RUN: would propose YES for MEM@CLE, Final 106-111 (ESPN), ESPN and balldontlie agree. Nothing was sent; propose by hand: horagon-ops propose ${ID} --box-score <url> --score 111-106`,
      ],
    ])
    expect(chain.sends).toEqual([])
    expect(await getEvidence(h.db, ID, 0)).toBeNull()
    expect((await getDraft(h.db, ID))?.state).toBe('pending')
    expect(await readProposeRecord(h.db, ID)).toBeNull()
    expect(logs.some((l) => l.msg === 'auto-propose dry run: would propose')).toBe(true)
    // 30 min on, the reminder says why.
    expect(await at(k, END + 1_800)).toEqual(['propose', 'alert'])
    expect(alerts.at(-1)?.[1]).toContain('auto-propose is a dry run')
  })

  it('skips while the chain clock is before end_ts, never as a failure', async () => {
    const k = keeperWith()
    await drafted(k)
    await at(k, END - 840)
    now = END + 5
    chain.clock = END - 3
    expect((await k.tick()).map((a) => a.type)).toEqual(['propose'])
    expect(chain.sends).toEqual([])
    expect(keys().filter((key) => key.startsWith('fail:'))).toEqual([])
    expect(logs.some((l) => l.msg === 'auto-propose skipped' && l.level === 30)).toBe(true)
    expect(await at(k, END + 10)).toEqual(['propose'])
    expect(chain.sends).toEqual([`propose ${ID}`])
  })

  it('a rejected propose alerts fail:, and the reminder names it', async () => {
    const k = keeperWith()
    await drafted(k)
    await at(k, END - 840)
    chain.fail = (label) =>
      label.startsWith('propose')
        ? new ProgramFailure(label, 'horagon', 6004, 'MarketNotOpen', [])
        : undefined
    expect(await at(k, END)).toEqual(['propose'])
    expect(alerts.at(-1)).toEqual([
      `fail:propose:${ID}`,
      `propose ${ID} rejected: propose ${ID}: horagon error MarketNotOpen`,
    ])
    expect(await at(k, END + 1_800)).toEqual(['propose', 'alert'])
    expect(alerts.at(-1)).toEqual([
      `unconfirmed:${ID}:0`,
      `MEM@CLE: final draft not proposed 30 min after proposing opened: auto-propose failing: propose ${ID}: horagon error MarketNotOpen. Propose by hand: horagon-ops propose ${ID} --box-score <url> --score 111-106`,
    ])
    // The keeper keeps trying, and the reminder went out once.
    chain.fail = undefined
    expect(await at(k, END + 1_805)).toEqual(['propose'])
    expect(chain.sends.filter((s) => s === `propose ${ID}`)).toHaveLength(3)
  })

  it("checks a guardian's --periods proposal raced by a tick against what is on chain", async () => {
    // ESPN's Final is wrong (111-106); balldontlie and the box score say 106-111.
    bdl = { status: 'Final', home: 106, away: 111 }
    const k = keeperWith()
    await drafted(k)
    expect(await at(k, END - 840)).toEqual([])
    expect(await at(k, END)).toEqual(['hold'])
    // Runbook K: the guardian proposes by hand with --score and --periods. Its draft is written
    // before the send; a keeper tick lands in between, while the chain still reads halted.
    const guardian = Keypair.generate()
    const swapped = QUARTERS.map(([h, a]) => [a, h] as [number, number])
    let raced: string[] = []
    const sender = {
      connection: chain.connection,
      send: async (spec: Parameters<typeof chain.sender.send>[0]) => {
        raced = await at(k, END + 10)
        return chain.sender.send(spec)
      },
    } as unknown as typeof chain.sender
    const out = await proposeResult(
      {
        db: h.db,
        connection: chain.connection,
        program,
        sender,
        signer: guardian,
        actor: 'guardian',
        now: () => new Date((END + 10) * 1000),
      },
      {
        gameId: ID,
        uri: URI,
        wish: {
          gameId: ID,
          status: 'final',
          home: 106,
          away: 111,
          periods: swapped,
          sourceUrl: BOX,
        },
        confirm: { name: 'basketball-reference', url: BOX },
        replace: false,
      },
    )
    expect(out.kind).toBe('landed')
    // The guardian's reading is not redrafted from ESPN.
    expect(raced).not.toContain('draft')
    expect(await getDraft(h.db, ID)).toMatchObject({ homeScore: 106, awayScore: 111 })
    // In the window balldontlie agrees with what is on chain: no MISMATCH page.
    // (The first tick syncs the row's times, which the CLI does not write.)
    expect(await at(k, END + 70)).toEqual(['sync'])
    expect(await at(k, END + 700)).toEqual([])
    expect(keys()).not.toContain(`source-mismatch:${ID}`)

    // A draft row that drifted from the chain's evidence still does not page a false MISMATCH:
    // the check reads the stored evidence whose hash is on chain.
    await setDraftState(h.db, ID, { state: 'pending' })
    await upsertDraft(h.db, DRAFT)
    await setDraftState(h.db, ID, { state: 'proposed' })
    const fresh = keeperWith()
    expect(await at(fresh, END + 760)).not.toContain('mismatch')
    expect(await at(fresh, END + 830)).not.toContain('mismatch')
    expect(keys()).not.toContain(`source-mismatch:${ID}`)
    // A balldontlie that contradicts the chain's evidence pages it, with the proposed score.
    bdl = { status: 'Final', home: 104, away: 111 }
    expect(await at(keeperWith(), END + 890)).toEqual(['mismatch'])
    expect(alerts.at(-1)?.[1]).toContain('balldontlie 111-104 vs proposed 111-106')
  })
})

describe('the page texts', () => {
  const g = { id: ID, away: 'MEM', home: 'CLE', gameDate: '2026-11-18' }
  const draft = { homeScore: 111, awayScore: 106 }

  it('links the basketball-reference box score, with its own team codes', () => {
    expect(boxScoreLink(g)).toBe(BOX)
    expect(boxScoreLink({ ...g, home: 'BKN' })).toBe(
      'https://www.basketball-reference.com/boxscores/202611180BRK.html',
    )
    expect(boxScoreLink({ ...g, home: 'CHA' })).toContain('0CHO.html')
    expect(boxScoreLink({ ...g, home: 'PHX' })).toContain('0PHO.html')
  })

  it('says NO for an away win, and the minutes of the wait', () => {
    const away = { homeScore: 100, awayScore: 104 }
    const hash = 'ab'.repeat(32)
    expect(
      autoProposedText(g, away, {
        check: 'match',
        reason: 'match',
        hashHex: hash,
        closesAt: END,
        waitSecs: 600,
      }),
    ).toBe(
      `Proposed NO for MEM@CLE, Final 104-100 (ESPN). ESPN and balldontlie agree. Nothing to do. The challenge window closes at ${utcAndEt(END)}. sha256 abababab...abab. If wrong: horagon-ops challenge ${ID}`,
    )
    expect(
      autoProposedText(g, draft, {
        check: 'unchecked',
        reason: 'pending',
        hashHex: hash,
        closesAt: END,
        waitSecs: 300,
      }),
    ).toContain('balldontlie had no final score 5 min after proposing opened')
  })

  it('builds the held and mismatch pages from the action', () => {
    expect(
      heldText(g, { espn: { home: 111, away: 106 }, second: { home: 110, away: 106 } }),
    ).toContain('HELD: MEM@CLE ESPN 106-111 vs balldontlie 106-110, nothing proposed.')
    expect(
      mismatchText(g, {
        proposed: { home: 111, away: 106 },
        second: { home: 110, away: 106 },
        challengeBy: END + 900,
      }),
    ).toContain(`Challenge before ${utcAndEt(END + 900)}:`)
  })

  it('writes the auto draft page only when given the time and the source', () => {
    const final = { status: 'final' as const, homeScore: 111, awayScore: 106 }
    expect(draftText(g, final, END, END - 900, { from: END, secondSource: 'off' })).toBe(
      `MEM@CLE Final 106-111 (ESPN). Auto-propose from ${utcAndEt(END)}, second source off. Nothing to do unless paged.`,
    )
    expect(draftText(g, final, END, END - 900, null)).toBe(draftText(g, final, END, END - 900))
  })
})

describe('autoProposeNotices', () => {
  it('alerts at start when the mode is off, and warns when nobody is paged', () => {
    expect(
      autoProposeNotices(
        { mode: 'off', publicUrl: null, off: 'HORAGON_PUBLIC_URL is not set' },
        true,
      ),
    ).toEqual({
      alert:
        'Auto-propose is off (HORAGON_PUBLIC_URL is not set): propose every result by hand (runbook A).',
      warn: null,
    })
    expect(
      autoProposeNotices({ mode: 'on', publicUrl: 'https://www.horagon.xyz', off: null }, false),
    ).toEqual({
      alert: null,
      warn: 'auto-propose is on but TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set: its pages reach this log only',
    })
    expect(
      autoProposeNotices({ mode: 'dry', publicUrl: 'https://www.horagon.xyz', off: null }, true),
    ).toEqual({ alert: null, warn: null })
  })
})
