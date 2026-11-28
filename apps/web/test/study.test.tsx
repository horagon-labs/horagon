// /study, "How the model is checked" (R10): a static page from the committed snapshot. It renders
// from a fixture snapshot and from the empty one, always says how small the sample is, and never
// uses the live colour (which means an open market).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type StudyRow, StudySnapshotSchema, studySnapshot } from '@horagon/sdk/study'
import { PublicKey } from '@solana/web3.js'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentView } from '../components/agent-view'
import { StudyView } from '../components/study-view'

const WEB = join(import.meta.dirname, '..')
const read = (...p: string[]) => readFileSync(join(WEB, ...p), 'utf8')
const ids = {
  horagon: 'HtDJ3vfx8vtFSmskm2Ks39kBMuDmFZH3H2B173BB9qHF',
  pmAmm: 'GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y',
}
const row = (n: number, over: Partial<StudyRow>): StudyRow => ({
  market: `Mkt${n}111111111111111111111111111111111111111`.slice(0, 44),
  gameMarket: `Gm${n}1111111111111111111111111111111111111111`.slice(0, 44),
  home: 'CHA',
  away: 'CHI',
  tipoff: '2026-11-26T00:00:00.000Z',
  initialPriceBps: 7_400,
  outcome: 'away',
  night: '2026-11-25',
  ...over,
})
/** A base58 string that decodes to a 32-byte key and prints back the same. */
const isPubkey = (s: string) => {
  try {
    return new PublicKey(s).toBase58() === s
  } catch {
    return false
  }
}
/** A market or game-market address: a real key, a PDA (off the curve), not a padded stand-in. */
const isMarketKey = (s: string) =>
  isPubkey(s) && !PublicKey.isOnCurve(new PublicKey(s).toBytes()) && !/1{6}/.test(s)
const SIM = { seed: 2026, paths: 40 }
const fixture = studySnapshot({
  generatedAt: '2026-11-28T08:00:00.000Z',
  slot: 431_000_000,
  programIds: ids,
  rows: [
    row(1, {}),
    row(2, { home: 'MIN', away: 'LAL', initialPriceBps: 2_800, outcome: 'home' }),
    row(3, {
      home: 'NYK',
      away: 'BOS',
      initialPriceBps: 6_100,
      outcome: 'home',
      night: '2026-11-27',
      tipoff: '2026-11-28T00:30:00.000Z',
    }),
  ],
  missing: [],
  notPlayed: [],
  lpSim: SIM,
})
const empty = studySnapshot({
  generatedAt: null,
  slot: null,
  programIds: ids,
  rows: [],
  missing: [],
  notPlayed: [],
  lpSim: SIM,
})
const game = (n: number, home: string, away: string) => {
  const { initialPriceBps: _p, outcome: _o, ...g } = row(n, { home, away })
  return g
}
/** One game not played (NO by rule), one account gone, one evidence that fails its hash. */
const withOff = studySnapshot({
  generatedAt: '2026-11-28T08:00:00.000Z',
  slot: 431_000_000,
  programIds: ids,
  rows: [row(1, {})],
  missing: [
    { ...game(5, 'LAL', 'DEN'), reason: 'account' },
    { ...game(6, 'PHX', 'SAC'), reason: 'evidence' },
  ],
  notPlayed: [game(4, 'MIA', 'ORL')],
  lpSim: SIM,
})

const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')

describe('/study from a fixture snapshot (R10)', () => {
  const html = renderToStaticMarkup(<StudyView snapshot={fixture} />)
  const text = textOf(html)

  it('says what the model is, and that its % is on chain and cannot change', () => {
    expect(html).toContain('>How the model is checked</h1>')
    expect(text).toContain('written on chain when the market opens')
    expect(text).toContain('cannot change')
  })

  it('shows N, both scores, both baselines and the bins with their counts', () => {
    expect(text).toContain('3 games over 2 ET nights (Nov 25, Nov 27).')
    expect(text).toContain(
      'Far too few to judge calibration; the table is published so anyone can check it as nights add up.',
    )
    expect(text).toContain(fixture.calibration.brier?.toFixed(3))
    expect(text).toContain(fixture.calibration.logLoss?.toFixed(3))
    expect(text).toContain('0.250')
    expect(text).toContain('0.693')
    expect(text).toContain('70–80%')
    expect(html.match(/data-bin=/g)).toHaveLength(5)
  })

  it('says how to recompute it: the command, the program ids, a link per row', () => {
    expect(text).toContain('pnpm --filter @horagon/keeper study')
    expect(text).toContain(ids.horagon)
    expect(text).toContain(ids.pmAmm)
    expect(text).toContain('slot 431000000')
    for (const r of fixture.rows) {
      expect(html).toContain(`https://explorer.solana.com/address/${r.market}?cluster=devnet`)
    }
  })

  it('marks the depth curve with the median Final and keeps the clock honest', () => {
    expect(text).toContain('wall-clock time to a fixed end_ts')
    expect(text).not.toContain('with the game clock')
    expect(text).toContain('median Final')
    expect(html.match(/<svg/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('labels the LP simulation and gives its seed', () => {
    expect(text).toContain('Simulation, not chain data')
    expect(text).toContain('seed 2026')
  })

  it('says a game not played is never scored, and counts only checked evidence', () => {
    expect(text).toContain(
      'A game not played within 7 days resolves NO by rule. That is no away win, so it is listed apart and never scored.',
    )
    expect(text).toContain(
      'its evidence, checked against the hash on chain, says the game was played',
    )
    expect(text).not.toContain('Not played, so not scored:')
    expect(text).not.toContain('Left out because')
  })

  it('lists the games not played and the markets left out, apart from the scored ones', () => {
    const off = textOf(renderToStaticMarkup(<StudyView snapshot={withOff} />))
    expect(off).toContain('Not played, so not scored: ORL @ MIA (Nov 25).')
    expect(off).toContain('Left out because the account is gone: DEN @ LAL (Nov 25).')
    expect(off).toContain(
      'Left out because the evidence could not be fetched or does not match the hash on chain: SAC @ PHX (Nov 25).',
    )
    expect(off).toContain('1 game over 1 ET night')
    expect(withOff.calibration.n).toBe(1)
  })

  it('states the upset rule in words', () => {
    expect(text).toContain('A game is an upset when its winner opened at 33% or less.')
  })

  it('never uses the live colour or a new hex', () => {
    expect(html).not.toMatch(/class="[^"]*\blive\b/)
    for (const f of ['study-view.tsx', 'study-charts.tsx']) {
      expect(read('components', f), f).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i)
    }
  })
})

describe('/study from the empty snapshot (R10)', () => {
  const text = textOf(renderToStaticMarkup(<StudyView snapshot={empty} />))

  it('says the first table comes after the first run, and still shows the sample line', () => {
    expect(text).toContain("The first table is published after the script's first run.")
    expect(text).toContain('0 games over 0 ET nights.')
    expect(text).toContain('Far too few to judge calibration')
    expect(text).toContain('Simulation, not chain data')
  })

  // The committed snapshot is regenerated from chain after each night, so this pins what holds
  // for any honest snapshot rather than its contents.
  it('ships a chain snapshot: real program ids and real keys, no fixture data', () => {
    const committed = StudySnapshotSchema.parse(JSON.parse(read('content', 'study.json')))
    expect(committed.programIds).toEqual(ids)
    if (committed.generatedAt === null) {
      // Before the first run: no rows, no missing or unplayed markets, no slot.
      expect(committed).toMatchObject({ slot: null, rows: [], missing: [], notPlayed: [] })
    } else {
      expect(committed.slot).toEqual(expect.any(Number))
    }
    const keys = [...committed.rows, ...committed.missing, ...committed.notPlayed].flatMap((r) => [
      r.market,
      r.gameMarket,
    ])
    for (const key of keys) expect(isMarketKey(key), key).toBe(true)
  })

  it('tells a market address from a fixture string', () => {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('m')], new PublicKey(ids.pmAmm))
    expect(isMarketKey(pda.toBase58())).toBe(true)
    expect(isPubkey(ids.horagon)).toBe(true)
    for (const n of [1, 2, 9]) {
      expect(isMarketKey(row(n, {}).market)).toBe(false)
      expect(isMarketKey(row(n, {}).gameMarket)).toBe(false)
    }
    expect(isMarketKey('not a key')).toBe(false)
  })
})

describe('the /study route (R10)', () => {
  it('is static: the snapshot is imported, no connection(), no client module', () => {
    const src = read('app', 'study', 'page.tsx')
    expect(src).toContain("from '../../content/study.json'")
    expect(src).not.toContain('connection')
    expect(src).not.toContain("'use client'")
    for (const f of ['study-view.tsx', 'study-charts.tsx']) {
      expect(read('components', f), f).not.toContain("'use client'")
    }
  })

  it('is linked from /agent', () => {
    const html = renderToStaticMarkup(<AgentView beat={null} />)
    expect(html).toMatch(/<a [^>]*href="\/study"[^>]*>How the model is checked<\/a>/)
  })
})
