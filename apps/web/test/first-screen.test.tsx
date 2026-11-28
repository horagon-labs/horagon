// First screen, slice 4 review finding 1 (first-screen spec §3, §7 page.tsx): how `/` lays out each
// state is one pure decision, `firstScreen` (lib/server/first-screen.ts), and page.tsx renders it.
// S1, S2 and S5 put the idle face in the dial's slot: the story card, or the R10 strip when
// /nights misses, with no face at all when there is no night to tell. S3 and S4 keep the Night
// dial, and the compact story follows the board. S5 tells the night that just ended. A Practice
// run on the court leads an idle face and makes its story compact below lg (S6). The unit tests
// pin the decision per state; the page tests render `/` itself from stubbed first-frame loaders,
// so the page's own wiring of that decision is pinned too.
import { readFileSync } from 'node:fs'
import {
  type Game,
  type Night,
  type NightGame,
  NightSchema,
  type PracticeResponse,
} from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TonightPage from '../app/page'
import { WalletProvider } from '../components/wallet'
import { at, game, market } from '../lib/chrono/fixtures'
import {
  initialBoard,
  initialLastNight,
  initialPractice,
  initialRecord,
  initialStory,
} from '../lib/server/api'
import { firstScreen, storyNight } from '../lib/server/first-screen'
import { type LastNight, rowsOfNight } from '../lib/server/last-night'
import { storyOfNight } from '../lib/server/story'

// The first frame's loaders and the request stand in, so `/` renders as a function of its data.
vi.mock('../lib/server/api', () => ({
  initialBoard: vi.fn(),
  initialLastNight: vi.fn(),
  initialPractice: vi.fn(),
  initialRecord: vi.fn(),
  initialStory: vi.fn(),
}))
vi.mock('next/server', () => ({ connection: vi.fn(async () => {}) }))
// The board's polls and clock: no answer yet and the server's clock, i.e. the first frame.
vi.mock('../lib/use-poll', () => ({
  POLL_MS: 3_000,
  usePoll: () => ({ data: undefined, error: undefined, failures: 0, refresh: () => {} }),
}))
vi.mock('../lib/chrono/now', async (actual) => ({
  ...(await actual<typeof import('../lib/chrono/now')>()),
  useNow: () => 0,
}))
// The board asks the router for a new frame (lib/use-refresh.ts); no app router here, and a
// server render runs no effect.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const nightFile = (name: string): Night =>
  NightSchema.parse(
    JSON.parse(
      readFileSync(new URL(`../../../tests/fixtures/nights/${name}`, import.meta.url), 'utf8'),
    ),
  )
/** The real ET 11-25 night as GET /nights serves it, and the story it tells (MIN @ OKC). */
const REAL = nightFile('2026-11-25.night.json')
const STORY = storyOfNight(REAL) as { night: Night; game: NightGame }
/** R10's newest final night before tonight's: ET 11-25 (11-26 had no game). */
const LAST: LastNight = { date: REAL.date, rows: rowsOfNight(REAL, 'none'), upsets: REAL.upsets }

// Friday ET 11-27's first two games (production's slate), and the night as it moves on.
const sched = (id: string, away: string, home: string, tip: string, p: number): Game =>
  game({
    id,
    away,
    home,
    status: 'scheduled',
    homeScore: 0,
    awayScore: 0,
    period: 0,
    clockSecs: null,
    scheduledTipoff: tip,
    modelProb: p,
    markets: [],
  })
const friday = () => [
  sched('nba-401909326', 'MIA', 'NYK', '2026-11-28T00:00:00.000Z', 0.788),
  sched('nba-401909327', 'MIL', 'DET', '2026-11-28T00:30:00.000Z', 0.917),
]
/** 5:58 PM ET: S2, the slate listed and no market open yet. */
const S2_NOW = at('2026-11-27T22:58:00Z')
/** 6:01 PM ET: NYK's market opened at the model's chance a minute ago (S3). */
const S3_NOW = at('2026-11-27T23:01:00Z')
/** 7:40 PM ET: NYK on the court in Q1, its market trading (S4). */
const S4_NOW = at('2026-11-28T00:40:00Z')
/** 10:40 PM ET: both games final and NYK's result proposed; the ET night is over (S5). */
const S5_NOW = at('2026-11-28T03:40:00Z')

const nykOpen = (g: Game): Game => ({
  ...g,
  markets: [
    market({
      pubkey: 'MktNyk1111111111111111111111111111111111111',
      initialPriceBps: 7_880,
      price: 0.788,
      priceTs: S3_NOW - 5,
      endTs: at('2026-11-28T05:32:00Z'),
    }),
  ],
})
const preopen = () => friday().map((g, i) => (i === 0 ? nykOpen(g) : g))
const live = () =>
  preopen().map((g, i) =>
    i === 0 ? { ...g, status: 'live' as const, homeScore: 15, awayScore: 11, period: 1 } : g,
  )
const stopped = () =>
  preopen().map((g) => ({
    ...g,
    status: 'final' as const,
    homeScore: 108,
    awayScore: 101,
    period: 4,
    clockSecs: null,
    markets: g.markets.map((m) => ({
      ...m,
      status: 'proposed' as const,
      outcome: 'yes' as const,
      price: 0.97,
      priceTs: S5_NOW - 600,
    })),
  }))

/** A Practice run on the court (MEM @ CLE, R8), FLAG_PRACTICE on. */
const RUN = game({ id: 'practice-401910007p0', league: 'PRACTICE', status: 'live' })
const PRACTICE: PracticeResponse = { current: RUN, nextAt: null, counterparty: 'none' }
/** Between runs: the next Practice tip-off in 1 h 45 min. */
const BETWEEN: PracticeResponse = { current: null, nextAt: S2_NOW + 6_300, counterparty: 'none' }

describe('the night the story tells (§3 S5, §6)', () => {
  it("S5: the night that just ended, from the board's own games, not R10's last night", () => {
    const night = storyNight(stopped(), S5_NOW, LAST)
    expect(night?.date).toBe('2026-11-27')
    expect(night?.rows.map((r) => r.winner)).toEqual(['NYK'])
  })

  it("S1-S4: R10's newest final night before tonight's", () => {
    expect(storyNight([], S2_NOW, LAST)).toBe(LAST)
    expect(storyNight(friday(), S2_NOW, LAST)).toBe(LAST)
    expect(storyNight(preopen(), S3_NOW, LAST)).toBe(LAST)
    expect(storyNight(live(), S4_NOW, LAST)).toBe(LAST)
    expect(storyNight(undefined, S2_NOW, LAST)).toBe(LAST)
  })

  it("S5 with no final NBA game of tonight's that has a winner market: R10's night", () => {
    const bare = stopped().map((g) => ({ ...g, markets: [] }))
    expect(storyNight(bare, S5_NOW, LAST)).toBe(LAST)
    expect(storyNight(bare, S5_NOW, null)).toBeNull()
  })
})

describe('firstScreen lays out each state (§3)', () => {
  const screen = (
    games: Game[] | undefined,
    now: number,
    over: {
      lastNight?: LastNight | null
      story?: { night: Night; game: NightGame } | null
      practice?: PracticeResponse | null
    } = {},
  ) =>
    firstScreen({
      games,
      now,
      lastNight: over.lastNight === undefined ? LAST : over.lastNight,
      story: over.story === undefined ? STORY : over.story,
      practice: over.practice ?? null,
    })

  it('S1 rest: the full story card takes the dial slot, its foot under it', () => {
    expect(screen([], S2_NOW)).toEqual({
      state: 'rest',
      night: LAST,
      idle: true,
      face: 'story',
      lead: null,
      compact: false,
    })
  })

  it('S2 later: the same, over the listed slate', () => {
    expect(screen(friday(), S2_NOW)).toEqual({
      state: 'later',
      night: LAST,
      idle: true,
      face: 'story',
      lead: null,
      compact: false,
    })
  })

  it('S2 with no first frame (the API late): no market known open, so still the idle face', () => {
    expect(screen(undefined, S2_NOW)).toMatchObject({ state: 'later', idle: true, face: 'story' })
  })

  it('S3 pre-open: the Night dial keeps the slot; no face, the compact story follows the board', () => {
    expect(screen(preopen(), S3_NOW)).toEqual({
      state: 'preopen',
      night: LAST,
      idle: false,
      face: null,
      lead: null,
      compact: false,
    })
  })

  it('S4 live: the same', () => {
    expect(screen(live(), S4_NOW)).toEqual({
      state: 'live',
      night: LAST,
      idle: false,
      face: null,
      lead: null,
      compact: false,
    })
  })

  it('S5 after: the idle face again, telling the night that just ended (currentNight)', () => {
    const s = screen(stopped(), S5_NOW)
    expect(s).toMatchObject({ state: 'after', idle: true, face: 'story', lead: null })
    expect(s.compact).toBe(false)
    expect(s.night?.date).toBe('2026-11-27')
    expect(s.night).not.toBe(LAST)
  })

  it('a /nights miss: the R10 strip stands in as the idle face, in S1, S2 and S5', () => {
    for (const [games, now] of [
      [[], S2_NOW],
      [friday(), S2_NOW],
      [stopped(), S5_NOW],
    ] as const) {
      expect(screen([...games], now, { story: null })).toMatchObject({
        idle: true,
        face: 'strip',
        lead: null,
        compact: false,
      })
    }
    // In S3/S4 the strip follows the board instead: no face.
    expect(screen(preopen(), S3_NOW, { story: null })).toMatchObject({ idle: false, face: null })
  })

  it('no night at all: no idle face in any state, so the board keeps its own layout', () => {
    for (const [games, now] of [
      [[], S2_NOW],
      [friday(), S2_NOW],
      [preopen(), S3_NOW],
    ] as const) {
      expect(screen([...games], now, { lastNight: null, story: null })).toMatchObject({
        night: null,
        idle: false,
        face: null,
        lead: null,
        compact: false,
      })
    }
  })

  it('S6: a Practice run leads an idle face and makes its story compact below lg', () => {
    for (const [games, now] of [
      [[], S2_NOW],
      [friday(), S2_NOW],
      [stopped(), S5_NOW],
    ] as const) {
      const s = screen([...games], now, { practice: PRACTICE })
      expect(s).toMatchObject({ idle: true, face: 'story', compact: true })
      expect(s.lead).toBe(RUN)
    }
    // Over a /nights miss the card still leads the strip.
    expect(screen(friday(), S2_NOW, { story: null, practice: PRACTICE })).toMatchObject({
      face: 'strip',
      lead: RUN,
      compact: true,
    })
  })

  it('S6 never leads the Night dial, and between runs or with the flag off nothing leads', () => {
    expect(screen(preopen(), S3_NOW, { practice: PRACTICE })).toMatchObject({
      idle: false,
      lead: null,
      compact: false,
    })
    expect(
      screen(friday(), S2_NOW, { lastNight: null, story: null, practice: PRACTICE }),
    ).toMatchObject({ idle: false, lead: null, compact: false })
    expect(screen(friday(), S2_NOW, { practice: BETWEEN })).toMatchObject({
      lead: null,
      compact: false,
    })
    expect(screen(friday(), S2_NOW, { practice: null })).toMatchObject({
      lead: null,
      compact: false,
    })
  })
})

describe('/ renders the layout firstScreen picks (§3, §7 page.tsx)', () => {
  beforeEach(() => vi.clearAllMocks())

  /** `/` as the server renders it, from these first-frame answers. */
  const page = async (p: {
    games: Game[] | undefined
    now: number
    lastNight?: LastNight | null
    story?: { night: Night; game: NightGame } | null
    practice?: PracticeResponse | null
  }) => {
    vi.mocked(initialBoard).mockResolvedValue({ games: p.games, upcoming: null, now: p.now })
    vi.mocked(initialLastNight).mockResolvedValue(p.lastNight === undefined ? LAST : p.lastNight)
    vi.mocked(initialPractice).mockResolvedValue(p.practice ?? null)
    vi.mocked(initialRecord).mockResolvedValue(null)
    vi.mocked(initialStory).mockResolvedValue(p.story === undefined ? STORY : p.story)
    return renderToStaticMarkup(<WalletProvider>{await TonightPage()}</WalletProvider>)
  }
  const count = (html: string, s: string) => html.split(s).length - 1

  it('S2: the full story card is the idle face, its foot follows, no compact story yet', async () => {
    const html = await page({ games: friday(), now: S2_NOW })
    expect(html).toMatch(/data-idle-face[^>]*>\s*<section [^>]*data-story-card="full"/)
    expect(html).toContain('data-idle-foot')
    expect(count(html, 'data-story-card=')).toBe(1)
    expect(html).not.toContain('data-open-foot')
    expect(html).not.toContain('data-idle-lead')
    expect(html).toContain('Wed, Nov 25 on the dial · 2 upsets')
    expect(vi.mocked(initialStory)).toHaveBeenCalledWith('2026-11-25', expect.any(Number))
  })

  it('S1: the same face over the rest card', async () => {
    const html = await page({ games: [], now: S2_NOW })
    expect(html).toMatch(/data-idle-face[^>]*>\s*<section [^>]*data-story-card="full"/)
    expect(html).toContain('data-idle-foot')
    expect(html).not.toContain('data-open-foot')
  })

  it('S3 and S4: no face; the compact story follows the board in the open foot', async () => {
    for (const [games, now] of [
      [preopen(), S3_NOW],
      [live(), S4_NOW],
    ] as const) {
      const html = await page({ games: [...games], now, practice: PRACTICE })
      expect(html).not.toContain('data-idle-face')
      expect(html).not.toContain('data-idle-foot')
      expect(html).not.toContain('data-idle-lead')
      expect(html).toMatch(/data-open-foot[^>]*>[\s\S]*data-story-card="compact"/)
      expect(count(html, 'data-story-card=')).toBe(1)
    }
  })

  it('S5: the face tells the night that just ended, loaded by its own date', async () => {
    const html = await page({ games: stopped(), now: S5_NOW, story: null })
    expect(vi.mocked(initialStory)).toHaveBeenCalledWith('2026-11-27', expect.any(Number))
    expect(html).toMatch(/data-idle-face[^>]*>\s*<section [^>]*data-last-night/)
    expect(html).toContain('Tonight on the dial · Fri, Nov 27 · no upsets')
    expect(html).not.toContain('data-open-foot')
  })

  it('a /nights miss: the R10 strip is the idle face, and no story card shows', async () => {
    const html = await page({ games: friday(), now: S2_NOW, story: null })
    expect(html).toMatch(/data-idle-face[^>]*>\s*<section [^>]*data-last-night/)
    expect(html).toContain('data-idle-foot')
    expect(html).not.toContain('data-story-card')
    expect(html).not.toContain('data-open-foot')
  })

  it('no night at all: no face and no foot; the open foot follows the board from the first frame', async () => {
    const html = await page({ games: friday(), now: S2_NOW, lastNight: null, story: null })
    expect(html).not.toContain('data-idle-face')
    expect(html).not.toContain('data-idle-foot')
    expect(html).toContain('data-open-foot')
    expect(html).not.toContain('data-story-card')
    expect(vi.mocked(initialStory)).not.toHaveBeenCalled()
  })

  it('S6: the Practice card leads, the story is compact below lg, the foot leaves the run to the card', async () => {
    const html = await page({ games: friday(), now: S2_NOW, practice: PRACTICE })
    expect(html).toMatch(/data-idle-lead[^>]*>\s*<section [^>]*data-practice-card/)
    expect(html).toMatch(/data-idle-face[^>]*>\s*<section [^>]*data-story-card="lg-full"/)
    const foot = html.slice(html.indexOf('data-idle-foot'))
    expect(foot).not.toContain('Practice game live')
  })

  it('between runs: no card, the full story, and the foot keeps the next tip-off line', async () => {
    const html = await page({ games: friday(), now: S2_NOW, practice: BETWEEN })
    expect(html).not.toContain('data-idle-lead')
    expect(html).toMatch(/data-idle-face[^>]*>\s*<section [^>]*data-story-card="full"/)
    const foot = html.slice(html.indexOf('data-idle-foot'))
    expect(foot).toContain('Next practice tip-off')
  })
})
