// First-screen W9 (spec §3 S2 "AgentNote (only when its claim holds)", §7 W9): the one line under
// the board on / says the disclosed agent moves prices when nobody trades. It renders only while
// that claim shows: the story night had reference-agent calls, or a listed market moved tonight.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Game, type Night, NightSchema } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import { at, game, market } from '../lib/chrono/fixtures'
import { agentNoteHolds } from '../lib/server/first-screen'

const WEB = join(import.meta.dirname, '..')
const read = (...p: string[]) => readFileSync(join(WEB, ...p), 'utf8')

const nightFile = (name: string): Night =>
  NightSchema.parse(
    JSON.parse(
      readFileSync(new URL(`../../../tests/fixtures/nights/${name}`, import.meta.url), 'utf8'),
    ),
  )

// Real ET 11-25 (no swaps on any market) and the synthetic moved night (12 agent calls).
const FLAT = nightFile('2026-11-25.night.json')
const MOVED = nightFile('moved.night.json')

// Fri, Nov 27, 3:16 AM ET (S2), 7:30 PM ET (S3/S4) and Sat 1:30 AM ET (S5).
const S2_NOW = at('2026-11-27T08:16:00Z')
const LIVE_NOW = at('2026-11-28T00:30:00Z')
const S5_NOW = at('2026-11-28T06:30:00Z')

const scheduled = (id: string, tip: string, markets: Game['markets'] = []): Game =>
  game({
    id,
    status: 'scheduled',
    homeScore: 0,
    awayScore: 0,
    period: 0,
    clockSecs: null,
    scheduledTipoff: tip,
    markets,
  })

const open = (
  bps: number,
  price: number,
  pubkey = 'MktOpen1111111111111111111111111111111111111',
) => market({ pubkey, status: 'open', initialPriceBps: bps, price, endTs: LIVE_NOW + 3 * 3600 })

describe('agentNoteHolds: the agent note shows only while its claim holds (W9)', () => {
  it('S2 on real data: a flat story night and no market yet hide the note', () => {
    const slate = [
      scheduled('nba-401909326', '2026-11-28T00:00:00.000Z'),
      scheduled('nba-401909327', '2026-11-28T00:30:00.000Z'),
    ]
    expect(agentNoteHolds(slate, S2_NOW, FLAT)).toBe(false)
  })

  it('a story night with reference-agent calls shows it, whatever the board holds', () => {
    expect(agentNoteHolds([], S2_NOW, MOVED)).toBe(true)
    const slate = [scheduled('nba-401909326', '2026-11-28T00:00:00.000Z')]
    expect(agentNoteHolds(slate, S2_NOW, MOVED)).toBe(true)
  })

  it('counts agent calls on any game of the story night, not only the story game', () => {
    const quiet = FLAT.games.map((g, i) =>
      i === 3 ? { ...g, calls: { fans: 0, fanWallets: 0, agent: 2, others: 0 } } : g,
    )
    expect(agentNoteHolds([], S2_NOW, { ...FLAT, games: quiet })).toBe(true)
  })

  it('fan calls alone on the story night do not make the agent claim', () => {
    const fans = FLAT.games.map((g, i) =>
      i === 0 ? { ...g, calls: { fans: 3, fanWallets: 2, agent: 0, others: 1 } } : g,
    )
    expect(agentNoteHolds([], S2_NOW, { ...FLAT, games: fans })).toBe(false)
  })

  it('S3 at the opening prices with a flat story night: no note', () => {
    const slate = [
      scheduled('nba-401909326', '2026-11-28T01:00:00.000Z', [open(7_884, 0.7884)]),
      scheduled('nba-401909327', '2026-11-28T01:30:00.000Z', [
        open(9_167, 0.9167, 'MktOpen2222222222222222222222222222222222222'),
      ]),
    ]
    expect(agentNoteHolds(slate, LIVE_NOW, FLAT)).toBe(false)
  })

  it('S4 with a listed market moved from its open: the note shows (real 11-27 NYK 79% to 67%)', () => {
    const nyk = game({
      id: 'nba-401909326',
      home: 'NYK',
      away: 'MIA',
      status: 'live',
      scheduledTipoff: '2026-11-28T00:00:00.000Z',
      markets: [open(7_884, 0.66527956036893)],
    })
    expect(agentNoteHolds([nyk], LIVE_NOW, FLAT)).toBe(true)
    expect(agentNoteHolds([nyk], LIVE_NOW, null)).toBe(true)
  })

  it('S5: a market of tonight that moved and has stopped still counts', () => {
    const fin = game({
      id: 'nba-401909327',
      status: 'final',
      period: 4,
      clockSecs: null,
      scheduledTipoff: '2026-11-28T03:00:00.000Z',
      markets: [market({ status: 'proposed', initialPriceBps: 9_167, price: 0.97 })],
    })
    expect(agentNoteHolds([fin], S5_NOW, FLAT)).toBe(true)
    const flatFin = {
      ...fin,
      markets: [market({ status: 'proposed', initialPriceBps: 9_167, price: 0.9167 })],
    }
    expect(agentNoteHolds([flatFin], S5_NOW, FLAT)).toBe(false)
  })

  it('a moved market off the 24 h list does not count, nor a market with no price', () => {
    const old = game({
      id: 'nba-401909300',
      status: 'final',
      scheduledTipoff: '2026-11-25T00:00:00.000Z',
      markets: [market({ status: 'finalized', initialPriceBps: 5_000, price: 0.9 })],
    })
    expect(agentNoteHolds([old], S5_NOW, FLAT)).toBe(false)
    const unpriced = scheduled('nba-401909326', '2026-11-28T01:00:00.000Z', [open(7_884, 0.7884)])
    const noPrice = {
      ...unpriced,
      markets: [{ ...(unpriced.markets[0] as Game['markets'][0]), price: null }],
    }
    expect(agentNoteHolds([noPrice], LIVE_NOW, FLAT)).toBe(false)
  })

  it('with no board and no story (the first frame missed both) there is no claim to show', () => {
    expect(agentNoteHolds(undefined, S2_NOW, null)).toBe(false)
    expect(agentNoteHolds(undefined, S2_NOW, undefined)).toBe(false)
  })
})

describe('page.tsx renders the agent note only when the claim holds (W9)', () => {
  const page = read('app', 'page.tsx')

  it('decides it on the server from the first frame and the story night', () => {
    expect(page).toMatch(
      /import \{[^}]*\bagentNoteHolds\b[^}]*\} from '\.\.\/lib\/server\/first-screen'/s,
    )
    expect(page).toContain('agentNoteHolds(initial.games, initial.now, story?.night)')
    expect(page).toMatch(/\{agentNote && <AgentNote \/>\}/)
    // Still the last thing on the page, after the board.
    expect(page.lastIndexOf('<AgentNote />')).toBeGreaterThan(page.indexOf('<TonightBoard'))
  })

  it('the note itself keeps its words and stays a server component', () => {
    expect(read('components', 'chrono', 'agent-line.tsx')).toContain(
      'When nobody trades, a disclosed Horagon agent moves prices toward the model. It never counts',
    )
    expect(read('lib', 'server', 'first-screen.ts')).not.toMatch(/^['"]use client['"]/m)
  })
})
