// The first screen's story (spec W1, C7-C12): which game of a night is told, its words, and the
// tape's geometry. Real ET 11-25 data, as GET /nights/2026-11-25 serves it from the public API's
// answers (packages/api/test/nights.test.ts pins the file), and the synthetic moved night beside
// it. Pure: no API, no DB.
import { readFileSync } from 'node:fs'
import { type Night, type NightGame, NightSchema } from '@horagon/sdk'
import { describe, expect, it, vi } from 'vitest'
import { heroMoved } from '../lib/chrono/board'
import { loadNight, STORY_TTL_MS } from '../lib/server/initial'
import { pickStory, STORY_PENDING, storyLines, storyOfNight, tapeModel } from '../lib/server/story'

const nightFile = (name: string): Night =>
  NightSchema.parse(
    JSON.parse(
      readFileSync(new URL(`../../../tests/fixtures/nights/${name}`, import.meta.url), 'utf8'),
    ),
  )

const REAL = nightFile('2026-11-25.night.json')
const MOVED_NIGHT = nightFile('moved.night.json')
const MOVED = MOVED_NIGHT.games[0] as NightGame
const MIN_OKC = REAL.games.find((g) => g.id === 'nba-401909320') as NightGame
const NOW = Date.parse('2026-11-27T08:16:00Z') / 1000

/** A copy of `g` with `over` on top. */
const like = (g: NightGame, over: Partial<NightGame>): NightGame => ({ ...g, ...over })

describe('pickStory (W1)', () => {
  it('picks MIN @ OKC on real ET 11-25 data: the lowest winner chance, 7%', () => {
    expect(pickStory(REAL)?.id).toBe('nba-401909320')
  })

  it('ranks a moved market above a deeper model low', () => {
    const night = { ...REAL, games: [...REAL.games, MOVED] }
    expect(pickStory(night)?.id).toBe(MOVED.id)
  })

  it('gives a tie on the shown % to the upset, and answers null for an empty night', () => {
    const low = MIN_OKC.low as NonNullable<NightGame['low']>
    const plain = like(MIN_OKC, {
      id: 'nba-1',
      upset: false,
      low: { ...low, prob: 0.071 },
    })
    const upset = like(MIN_OKC, { id: 'nba-2', upset: true, low: { ...low, prob: 0.074 } })
    expect(pickStory({ ...REAL, games: [plain, upset] })?.id).toBe('nba-2')
    expect(pickStory({ ...REAL, games: [plain, like(upset, { upset: false })] })?.id).toBe('nba-1')
    expect(pickStory({ ...REAL, games: [] })).toBeNull()
  })

  it('storyOfNight pairs the night with its story, or null', () => {
    expect(storyOfNight(REAL)).toEqual({ night: REAL, game: MIN_OKC })
    expect(storyOfNight({ ...REAL, games: [] })).toBeNull()
  })
})

describe('storyLines on real ET 11-25 data (C7, C8, C11, C12)', () => {
  const s = storyLines(MIN_OKC, NOW)

  it('says the upset from 28% before tip-off, and the model low with the score behind', () => {
    expect(s.plate).toBe('Upset')
    expect(s.line1).toBe('MIN won 113–106 from 28% before tip-off')
    expect(s.line2).toBe('The model had MIN at 7% at Q3 5:41, down 63–74.')
    expect(s.readout).toEqual(['Q3 5:41 · 63–74', 'MIN to win 7%', 'model'])
  })

  it('claims no move: no tally, no buzzer price, not moved', () => {
    expect(s.moved).toBe(false)
    expect(s.tally).toBeNull()
    expect(`${s.line1} ${s.line2}`).not.toMatch(/price|closed|calls/)
    expect(heroMoved([], NOW, s.moved)).toBe(false)
  })

  it('links the final result to /verify (string 20)', () => {
    expect(s.proof).toEqual({
      kind: 'final',
      text: 'Result on-chain · MIN won · Check it yourself',
      href: '/verify/54WUazC5Dcit8K8mjigTgNQfvEjeFxdUWU7QEDNPaD4G',
    })
  })
})

describe('storyLines on the synthetic moved night (C8 moved, C8t)', () => {
  const s = storyLines(MOVED, NOW)

  it('tells the buzzer price, the tally and the price low', () => {
    expect(s.plate).toBeNull()
    expect(s.line1).toBe('NYK won 110–100')
    expect(s.line2).toBe('At the buzzer the price had NYK at 81%.')
    expect(s.moved).toBe(true)
    expect(s.tally).toEqual({
      parts: ['14 calls', '2 by fans', '12 by the reference agent'],
      text: '14 calls · 2 by fans · 12 by the reference agent',
    })
    expect(s.readout).toEqual(['Q2 6:00 · 38–47', 'NYK to win 35%', 'price'])
    expect(heroMoved([], NOW, s.moved)).toBe(true)
  })

  it('counts one call and one fan in the singular', () => {
    const one = storyLines(
      like(MOVED, { calls: { fans: 1, fanWallets: 1, agent: 0, others: 0 } }),
      NOW,
    )
    expect(one.tally?.text).toBe('1 call · 1 by a fan · 0 by the reference agent')
  })

  it('times a proposed result, names a challenge, and waits for one not proposed yet', () => {
    const at = (status: NightGame['resolution']['status'], challengeEndsAt: number | null = null) =>
      storyLines(like(MOVED, { resolution: { ...MOVED.resolution, status, challengeEndsAt } }), NOW)
        .proof
    expect(at('proposed', NOW + 600)).toMatchObject({
      kind: 'proposed',
      text: 'Result proposed · final in 10:00 unless a guardian challenges',
    })
    expect(at('proposed')).toMatchObject({
      text: 'Result proposed: the challenge window is open',
    })
    expect(at('challenged')).toMatchObject({ kind: 'challenged', text: 'Result under review' })
    for (const status of ['open', 'halted'] as const) {
      expect(at(status)).toMatchObject({ kind: 'pending', text: STORY_PENDING })
    }
    expect(STORY_PENDING).toBe(
      'The result goes on-chain after a box-score check. The morning read is ready at 6:00 AM ET.',
    )
    expect(at('finalized').kind).toBe('final')
    expect(at('recycled').kind).toBe('final')
    for (const status of ['proposed', 'open', 'finalized'] as const) {
      expect(at(status).href).toBe(`/verify/${MOVED.market}`)
    }
  })
})

describe('storyLines plates (C7)', () => {
  const base = like(MIN_OKC, { upset: false })

  it('a comeback: the model had the winner at 10% or less, named with its period', () => {
    const s = storyLines(base, NOW)
    expect(s.plate).toBe('Comeback')
    expect(s.line1).toBe('MIN won 113–106 after the model had them at 7% in Q3')
  })

  it('overtime, then no plate; line 2 only while the winner trailed at the low', () => {
    const low = base.low as NonNullable<NightGame['low']>
    const higher = like(base, {
      low: { ...low, prob: 0.3 },
      model: base.model.map(([t, p]) => [t, Math.max(p, 0.3)]),
    })
    const ot = storyLines(like(higher, { overtime: true, period: 5 }), NOW)
    expect(ot.plate).toBe('Overtime')
    expect(ot.line1).toBe('MIN won 113–106 in overtime')
    const plain = storyLines(higher, NOW)
    expect(plain.plate).toBeNull()
    expect(plain.line1).toBe('MIN won 113–106')
    expect(plain.line2).toBe('The model had MIN at 30% at Q3 5:41, down 63–74.')
    const ahead = storyLines(like(higher, { low: { ...low, prob: 0.3, winnerScore: 80 } }), NOW)
    expect(ahead.line2).toBeNull()
    expect(ahead.readout?.[0]).toBe('Q3 5:41 · 80–74')
  })

  it('a comeback in a moved game reads the model line, not the price low', () => {
    const s = storyLines(
      like(MOVED, { model: MOVED.model.map(([t, p], i) => [t, i === 7 ? 0.08 : p]) }),
      NOW,
    )
    expect(s.plate).toBe('Comeback')
    expect(s.line1).toBe('NYK won 110–100 after the model had them at 8% in Q3')
  })

  it('no low at all: line 1 only, no readout', () => {
    const s = storyLines(like(base, { low: null, model: [], upset: true }), NOW)
    expect(s.line1).toBe('MIN won 113–106 from 28% before tip-off')
    expect(s.line2).toBeNull()
    expect(s.readout).toBeNull()
  })
})

describe('tapeModel (C10, G1)', () => {
  it('draws the model line across the box, Q1-Q4, opened 28% at the left, 7% at the low', () => {
    const t = tapeModel(MIN_OKC, { w: 340, h: 96 })
    expect(t.caption).toBe('MIN @ OKC · MIN to win · model')
    expect(t.legend).toEqual(['▲ Model'])
    expect(t.price).toBeNull()
    expect(t.model).toMatch(/^M0,[\d.]+(L[\d.]+,[\d.]+){59}$/)
    expect(t.periods.map((p) => p.label)).toEqual(['Q1', 'Q2', 'Q3', 'Q4'])
    expect(t.rules).toHaveLength(3)
    for (const x of t.rules) expect(x).toBeGreaterThan(0)
    expect(t.opened).toEqual({ x: 0, y: expect.closeTo(96 * (1 - 0.2819), 1), label: 'opened 28%' })
    expect(t.low?.label).toBe('7%')
    expect(t.low?.y).toBeCloseTo(96 * (1 - 0.0737), 1)
    // The low (Q3 5:41) sits between the Q3 and Q4 rules.
    expect(t.low?.x).toBeGreaterThan(t.rules[1] as number)
    expect(t.low?.x).toBeLessThan(t.rules[2] as number)
    expect(t.final).toEqual({ x: 340, y: 0, label: 'Final 113–106' })
  })

  it('keeps inside the padding, and draws the price only for a moved game', () => {
    const pad = { top: 10, right: 20, bottom: 14, left: 30 }
    const t = tapeModel(MOVED, { w: 600, h: 132, pad })
    expect(t.caption).toBe('MIA @ NYK · NYK to win · price and model')
    expect(t.legend).toEqual(['▲ Model', '— Price'])
    const xy = (d: string) =>
      [...d.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])])
    for (const d of [t.model, t.price as string]) {
      for (const [x, y] of xy(d)) {
        expect(x).toBeGreaterThanOrEqual(30)
        expect(x).toBeLessThanOrEqual(580)
        expect(y).toBeGreaterThanOrEqual(10)
        expect(y).toBeLessThanOrEqual(118)
      }
    }
    // The price opened before tip-off: its line starts at the left edge, at the price then.
    expect(xy(t.price as string)[0]).toEqual([30, expect.closeTo(10 + 108 * (1 - 0.61), 1)])
    expect(t.low).toMatchObject({ label: '35%', y: expect.closeTo(10 + 108 * 0.65, 1) })
    expect(t.opened.label).toBe('opened 60%')
    expect(t.final.label).toBe('Final 110–100')
  })

  it('labels overtime periods OT', () => {
    const extra = (MIN_OKC.model.at(-1) as [number, number])[0]
    const t = tapeModel(
      like(MIN_OKC, {
        periodStarts: [...MIN_OKC.periodStarts, extra - 60],
        period: 5,
        overtime: true,
      }),
      { w: 340, h: 96 },
    )
    expect(t.periods.map((p) => p.label)).toEqual(['Q1', 'Q2', 'Q3', 'Q4', 'OT'])
  })
})

describe('loadNight and STORY_TTL_MS (initialStory)', () => {
  it('keeps a story 10 min, and answers the night, or null when the API fails or is late', async () => {
    expect(STORY_TTL_MS).toBe(600_000)
    const ok = { nights: vi.fn(async () => REAL) }
    expect(await loadNight(ok, '2026-11-25')).toBe(REAL)
    expect(ok.nights).toHaveBeenCalledWith('2026-11-25')
    const failing = { nights: vi.fn(async () => Promise.reject(new Error('down'))) }
    expect(await loadNight(failing, '2026-11-25')).toBeNull()
    const late = { nights: vi.fn(() => new Promise<Night>(() => {})) }
    expect(await loadNight(late, '2026-11-25', 5)).toBeNull()
  })
})

describe('story.ts stays on the server', () => {
  it("starts with import 'server-only', and no client module imports it", async () => {
    const { readdirSync } = await import('node:fs')
    const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
    expect(src('lib/server/story.ts')).toMatch(/^(\/\/.*\n)*import 'server-only'\n/)
    for (const dir of ['components', 'components/chrono', 'lib', 'lib/chrono', 'app']) {
      for (const f of readdirSync(new URL(`../${dir}`, import.meta.url))) {
        if (!/\.tsx?$/.test(f)) continue
        const text = src(`${dir}/${f}`)
        if (/^['"]use client['"]/m.test(text)) expect(text, f).not.toMatch(/server\/story/)
      }
    }
  })
})
