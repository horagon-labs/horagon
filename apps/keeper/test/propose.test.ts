import {
  type DbHandle,
  getDraft,
  getEvidence,
  getGame,
  listOps,
  putEvidence,
  setDraftState,
} from '@horagon/db'
import { createTestDb } from '@horagon/db/testing'
import { parseResolutionEvidence } from '@horagon/sdk'
import { Keypair } from '@solana/web3.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildEvidence, sealEvidence } from '../src/evidence'
import { UnresolvedAttempt } from '../src/executor'
import { EvidenceRefusal, readProposeRecord } from '../src/ops/propose-evidence'
import {
  evidenceUri,
  type ProposeDeps,
  type ProposeOutcome,
  type ProposeRequest,
  proposeResult,
  publicBaseUrl,
  refusalText,
} from '../src/propose'
import {
  DRAFT,
  END,
  FakeChain,
  ID,
  program,
  proposeArgs,
  STATUS,
  seedDraft,
  seedGame,
  seedMarket,
} from './chain-fixtures'

const BOX = 'https://www.nba.com/game/mem-vs-cle-0022600234/box-score'
const URI = `https://horagon.vercel.app/api/v1/evidence/${ID}/winner`
const AT = new Date((END + 30) * 1000)
const guardian = Keypair.generate()
const attestor = Keypair.generate()

let h: DbHandle
let chain: FakeChain
let said: string[]
let warned: string[]

beforeEach(async () => {
  h = await createTestDb()
  await seedGame(h.db)
  const marketId = await seedMarket(h.db)
  await seedDraft(h.db)
  chain = new FakeChain(marketId, attestor.publicKey, END + 10)
  chain.setMarket(STATUS.halted)
  said = []
  warned = []
})
afterEach(async () => {
  await h.close()
  expect(chain.doneProblems).toEqual([])
})

const deps = (over: Partial<ProposeDeps> = {}): ProposeDeps => ({
  db: h.db,
  connection: chain.connection,
  program,
  sender: chain.sender,
  signer: guardian,
  actor: 'guardian',
  now: () => AT,
  say: (l) => void said.push(l),
  warn: (l) => void warned.push(l),
  ...over,
})

/** What `horagon-ops propose <id> --box-score <nba.com> --score 111-106` asks for. */
const guardianRun = (over: Partial<ProposeRequest> = {}): ProposeRequest => ({
  gameId: ID,
  uri: URI,
  wish: {
    gameId: ID,
    status: 'final',
    home: 111,
    away: 106,
    periods: null,
    sourceUrl: BOX,
  },
  confirm: { name: 'nba', url: BOX },
  replace: false,
  ...over,
})

/** What the keeper asks for: the pending draft as it is, sealed once, never replaced. */
const keeperRun = (confirm: ProposeRequest['confirm']): ProposeRequest => ({
  gameId: ID,
  uri: URI,
  wish: {
    gameId: ID,
    status: 'final',
    home: 111,
    away: 106,
    periods: null,
    sourceUrl: DRAFT.sourceUrl,
  },
  confirm,
  replace: false,
  keepStored: true,
})
const keeperDeps = () =>
  deps({ signer: attestor, actor: 'keeper', say: undefined, warn: undefined })

const row = async () => (await getGame(h.db, ID))?.markets[0]

/** The CLI's words for a run that sent nothing. */
const refusal = (out: ProposeOutcome) => {
  if (out.kind === 'landed') throw new Error('expected a refusal, the run landed')
  return refusalText(ID, out)
}

const attempts = async () => {
  const record = await readProposeRecord(h.db, ID)
  if (record === null || record === 'unreadable') throw new Error('no propose record')
  return record.attempts
}

describe('the propose core, as horagon-ops runs it', () => {
  it('seals, records, sends, then writes the draft, the market row and the ops log', async () => {
    const out = await proposeResult(deps(), guardianRun())
    expect(out).toMatchObject({ kind: 'landed', signature: 'sig1', reused: false })
    if (out.kind !== 'landed') throw new Error('not landed')

    expect(chain.sends).toEqual([`propose ${ID}`])
    const ix = proposeArgs(chain.specs[0] as (typeof chain.specs)[0])
    expect(ix.signer.equals(guardian.publicKey)).toBe(true)
    expect(ix.signed).toBe(true)
    expect(ix.uri).toBe(URI)

    const stored = await getEvidence(h.db, ID, 0)
    expect(stored?.hash).toBe(out.sealed.hashHex)
    expect(JSON.parse(stored?.json ?? '{}').sources).toEqual([
      { name: 'espn', url: DRAFT.sourceUrl, fetchedAt: '2026-11-18T13:51:40Z' },
      { name: 'nba', url: BOX, fetchedAt: '2026-11-18T14:07:10Z' },
    ])
    expect((await getDraft(h.db, ID))?.state).toBe('proposed')
    expect(await row()).toMatchObject({
      status: 'proposed',
      evidenceHash: out.sealed.hashHex,
      proposeSig: 'sig1',
    })
    const [op] = await listOps(h.db)
    expect(op).toMatchObject({
      actor: 'guardian',
      action: 'propose',
      gameId: ID,
      sig: 'sig1',
      detail: { outcome: 'yes', hash: out.sealed.hashHex },
    })
    expect(await readProposeRecord(h.db, ID)).toEqual({
      hash: out.sealed.hashHex,
      round: 0,
      attempts: [{ at: END + 30, state: 'landed', sig: 'sig1', ended: END + 30 }],
    })
    // The CLI's own lines, in its order.
    expect(said).toEqual([
      'proposed YES for MEM@CLE (sig1)',
      `evidence ${URI}  sha256 ${out.sealed.hashHex}`,
    ])
    expect(warned).toEqual([])
  })

  it('refuses before end_ts and on a market it cannot propose, with the words the CLI prints', async () => {
    chain.clock = END - 1
    const early = await proposeResult(deps(), guardianRun())
    expect(early).toEqual({ kind: 'not-yet', endTs: END, chainNow: END - 1 })
    expect(refusal(early)).toBe(
      `${ID}: proposing opens at end_ts ${new Date(END * 1000).toISOString()}`,
    )
    chain.clock = END + 10
    chain.setMarket(STATUS.proposed)
    const done = await proposeResult(deps(), guardianRun())
    expect(done).toEqual({ kind: 'not-proposable', status: 'proposed' })
    expect(refusal(done)).toBe(`${ID}: market is proposed, nothing to propose`)
    chain.accounts.delete(chain.gm)
    const missing = await proposeResult(deps(), guardianRun())
    expect(refusal(missing)).toBe(`${ID}: market is missing, nothing to propose`)
    // Nothing was sent or written.
    expect(chain.sends).toEqual([])
    expect(await getEvidence(h.db, ID, 0)).toBeNull()
    expect((await getDraft(h.db, ID))?.state).toBe('pending')
    expect(await readProposeRecord(h.db, ID)).toBeNull()
  })

  it('prints the box-score warning and the reuse line, as the CLI did', async () => {
    await proposeResult(
      deps(),
      guardianRun({
        confirm: { name: 'espn-box-score', url: BOX, warning: 'ESPN is also the automated feed' },
      }),
    )
    expect(warned).toEqual(['warning: ESPN is also the automated feed'])
  })

  it('a re-run after an unresolved send sends the stored evidence, without a write', async () => {
    chain.fail = () => new UnresolvedAttempt(`propose ${ID}: still unresolved after 90 s`)
    await expect(proposeResult(deps(), guardianRun())).rejects.toThrow(UnresolvedAttempt)
    const first = await getEvidence(h.db, ID, 0)
    expect((await attempts())[0]).toMatchObject({
      state: 'unresolved',
      height: 1_000,
    })
    chain.fail = undefined
    const out = await proposeResult(
      deps({ now: () => new Date((END + 300) * 1000) }),
      guardianRun(),
    )
    expect(out).toMatchObject({ kind: 'landed', reused: true })
    expect(said[0]).toBe(`sending the evidence an earlier propose stored (sha256 ${first?.hash})`)
    expect(await getEvidence(h.db, ID, 0)).toEqual(first)
  })

  it('refuses a draft already proposed, as nextDraft does', async () => {
    await setDraftState(h.db, ID, { state: 'proposed' })
    await expect(proposeResult(deps(), guardianRun())).rejects.toThrow(
      `${ID}: no pending final draft to propose; run status`,
    )
    expect(chain.sends).toEqual([])
  })
})

describe('the propose core, as the keeper runs it', () => {
  it('signs with the attestor, logs actor keeper, and seals 1-source evidence that parses', async () => {
    const out = await proposeResult(keeperDeps(), keeperRun(null))
    if (out.kind !== 'landed') throw new Error('not landed')
    const ix = proposeArgs(chain.specs[0] as (typeof chain.specs)[0])
    expect(ix.signer.equals(attestor.publicKey)).toBe(true)
    const json = (await getEvidence(h.db, ID, 0))?.json ?? ''
    const evidence = parseResolutionEvidence(JSON.parse(json))
    expect(evidence.sources).toEqual([
      { name: 'espn', url: DRAFT.sourceUrl, fetchedAt: '2026-11-18T13:51:40Z' },
    ])
    expect(evidence).toMatchObject({ outcome: 'yes', homeScore: 111, awayScore: 106 })
    expect((await listOps(h.db))[0]).toMatchObject({ actor: 'keeper', action: 'propose' })
  })

  it('names the second source it matched, at the time it read it', async () => {
    const at = new Date((END - 120) * 1000)
    const url = 'https://api.balldontlie.io/v1/games/18447001'
    await proposeResult(keeperDeps(), keeperRun({ name: 'balldontlie', url, at }))
    const json = (await getEvidence(h.db, ID, 0))?.json ?? ''
    expect(JSON.parse(json).sources[1]).toEqual({
      name: 'balldontlie',
      url,
      fetchedAt: '2026-11-18T14:04:40Z',
    })
  })

  it('a retry re-sends the stored row unchanged, with no write, whatever the source says now', async () => {
    chain.fail = () => new UnresolvedAttempt(`propose ${ID}: still unresolved after 90 s`)
    await expect(proposeResult(keeperDeps(), keeperRun(null))).rejects.toThrow(UnresolvedAttempt)
    const first = await getEvidence(h.db, ID, 0)
    chain.fail = undefined
    // balldontlie answered since: the retry still sends the row sealed first.
    const later = { name: 'balldontlie', url: 'https://api.balldontlie.io/v1/games/1', at: AT }
    const out = await proposeResult(keeperDeps(), keeperRun(later))
    expect(out).toMatchObject({ kind: 'landed', reused: true })
    if (out.kind !== 'landed') throw new Error('not landed')
    expect(out.sealed.hashHex).toBe(first?.hash)
    const [a, b] = chain.specs.map((s) => Buffer.from(proposeArgs(s).hash).toString('hex'))
    expect(a).toBe(first?.hash)
    expect(b).toBe(first?.hash)
    expect(await getEvidence(h.db, ID, 0)).toEqual(first)
  })

  it('never replaces stored evidence of other inputs: refused before anything is sent', async () => {
    const other = await sealEvidence(
      buildEvidence({
        game: { league: 'NBA', externalId: '401910007', home: 'CLE', away: 'MEM' },
        draft: {
          ...DRAFT,
          homeScore: 112,
          periods: [...DRAFT.periods.slice(0, 3), [28, 24]],
        },
        kind: 0,
        confirmUrl: BOX,
        confirmSource: 'nba',
        confirmedAt: AT,
      }),
    )
    await putEvidence(h.db, { gameId: ID, kind: 0, json: other.json, hash: other.hashHex })
    await expect(proposeResult(keeperDeps(), keeperRun(null))).rejects.toThrow(EvidenceRefusal)
    expect(chain.sends).toEqual([])
    expect((await getEvidence(h.db, ID, 0))?.hash).toBe(other.hashHex)
    expect((await getDraft(h.db, ID))?.state).toBe('pending')
    // Stored bytes that are not the canonical form of what they hold are refused too.
    await putEvidence(h.db, { gameId: ID, kind: 0, json: `${other.json} `, hash: other.hashHex })
    await expect(proposeResult(keeperDeps(), keeperRun(null))).rejects.toThrow(EvidenceRefusal)
  })
})

describe('the evidence URI', () => {
  it('is the https site plus the evidence path; http only on localnet', () => {
    expect(evidenceUri('https://horagon.vercel.app/', 'devnet', ID)).toBe(URI)
    expect(publicBaseUrl('https://www.horagon.xyz', 'devnet')).toBe('https://www.horagon.xyz')
    expect(publicBaseUrl('http://127.0.0.1:3000', 'localnet')).toBe('http://127.0.0.1:3000')
    expect(() => publicBaseUrl('http://127.0.0.1:3000', 'devnet')).toThrow(
      'HORAGON_PUBLIC_URL must be https',
    )
    expect(() => publicBaseUrl('nope', 'devnet')).toThrow('HORAGON_PUBLIC_URL is not a URL')
    const long = `https://${'a'.repeat(100)}.example`
    expect(() => evidenceUri(long, 'devnet', ID)).toThrow(
      /^the evidence URI is longer than 128 characters: https:\/\/a+\.example\/api/,
    )
  })
})
