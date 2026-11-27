// First screen, slice 6 "Practice" (first-screen spec §3 S6, §5 C24, §7 W8/W8b, §11 row 6): while a
// Practice run is on the court and no NBA market is open, the Practice card leads the idle face
// (the PRACTICE plate, string 26, the recording, the score and price, who else trades, and a filled
// ink "Play along"), the story card shrinks to its compact form below lg and stays full from lg,
// and from lg the card tops the list's column. Between runs the foot keeps R8's one line. With
// FLAG_PRACTICE off nothing shows. The card is a server component; only its score and price poll,
// every 15 s and only while the run is on (W8b). No Live blue: blue means an NBA market is open.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Game,
  type Night,
  type NightGame,
  NightSchema,
  type PracticeResponse,
} from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BoardView, type BoardViewProps } from '../components/chrono/board-view'
import { PracticeCard } from '../components/chrono/practice-card'
import { PRACTICE_POLL_MS, PracticeLive } from '../components/chrono/practice-live'
import { PracticeStrip } from '../components/chrono/practice-strip'
import { StoryCard } from '../components/story-card'
import { TonightBoard } from '../components/tonight-board'
import { WalletProvider } from '../components/wallet'
import { at, game, market, NOW } from '../lib/chrono/fixtures'
import {
  COUNTERPARTY_AGENT,
  COUNTERPARTY_NONE,
  PLAY_ALONG,
  PRACTICE_LINE,
  practiceLive,
  practiceLiveLine,
  practiceStrip,
} from '../lib/chrono/practice'
import { practicePrice, practiceScore } from '../lib/chrono/practice-live'

// The polls and the clock, stubbed (web tests have no DOM): what a tick answered per key, and every
// key and interval asked for, in order.
const stub = vi.hoisted(() => ({
  games: undefined as Game[] | undefined,
  practice: undefined as PracticeResponse | undefined,
  now: 0,
  calls: [] as Array<[string | null, number | undefined]>,
}))
vi.mock('../lib/use-poll', () => ({
  POLL_MS: 3_000,
  usePoll: (key: string | null, _load: unknown, everyMs?: number) => {
    stub.calls.push([key, everyMs])
    return {
      data: key === 'games' ? stub.games : key?.startsWith('practice') ? stub.practice : undefined,
      error: undefined,
      failures: 0,
      refresh: () => {},
    }
  },
}))
vi.mock('../lib/chrono/now', async (actual) => ({
  ...(await actual<typeof import('../lib/chrono/now')>()),
  useNow: () => stub.now,
}))

const WEB = join(import.meta.dirname, '..')
const read = (...p: string[]) => readFileSync(join(WEB, ...p), 'utf8')
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')

/** Any Live blue class: none belongs on the Practice card (§4, §9). */
const LIVE = /\b(text|bg|stroke|fill|border)-live\b/

/** Run 0 replays MEM @ CLE (ESPN 401910007), recorded on Nov 18 ET: Q3 4:12, MEM 78–84 CLE. */
const RUN = game({ id: 'practice-401910007p0', league: 'PRACTICE', status: 'live' })
const resp = (over: Partial<PracticeResponse> = {}): PracticeResponse => ({
  current: RUN,
  nextAt: null,
  counterparty: 'none',
  ...over,
})
const iso = (s: number) => new Date(s * 1000).toISOString()

describe('the run on the court (S6: practiceLive)', () => {
  it('is the current run while it is live, or scheduled and past its tip-off', () => {
    expect(practiceLive(resp(), NOW)).toBe(RUN)
    const late = { ...RUN, status: 'scheduled' as const, scheduledTipoff: iso(NOW - 30) }
    expect(practiceLive(resp({ current: late }), NOW)).toBe(late)
  })

  it('is null between runs, after the Final and with FLAG_PRACTICE off', () => {
    const soon = { ...RUN, status: 'scheduled' as const, scheduledTipoff: iso(NOW + 300) }
    expect(practiceLive(resp({ current: soon }), NOW)).toBeNull()
    expect(practiceLive(resp({ current: { ...RUN, status: 'final' } }), NOW)).toBeNull()
    expect(practiceLive(resp({ current: null, nextAt: NOW + 600 }), NOW)).toBeNull()
    expect(practiceLive(null, NOW)).toBeNull()
  })

  it("says line 1 in R8's words, the strip's own", () => {
    expect(practiceLiveLine(RUN)).toBe('Practice game live · MEM @ CLE · Replay')
    expect(practiceStrip(resp(), NOW)?.text).toBe(practiceLiveLine(RUN))
  })
})

describe('the score and the price (C24, W8b)', () => {
  it('reads "MEM 78–84 CLE · Q3 4:12" while on, "· Half", and "· Final" once over', () => {
    expect(practiceScore(RUN)).toBe('MEM 78–84 CLE · Q3 4:12')
    expect(practiceScore({ ...RUN, period: 2, clockSecs: 0 })).toBe('MEM 78–84 CLE · Half')
    expect(
      practiceScore({ ...RUN, status: 'final', period: 4, clockSecs: null, homeScore: 98 }),
    ).toBe('MEM 78–98 CLE · Final')
    // Not tipped off on the feed yet: no score to tell.
    expect(practiceScore({ ...RUN, status: 'scheduled' })).toBeNull()
  })

  it('reads "CLE to win" and "77%" while the replay\'s market trades, and nothing after', () => {
    expect(practicePrice(RUN)).toEqual({ subject: 'CLE to win', value: '77%' })
    expect(practicePrice({ ...RUN, status: 'final' })).toBeNull()
    expect(practicePrice({ ...RUN, markets: [market({ price: null })] })).toBeNull()
    expect(practicePrice({ ...RUN, markets: [market({ status: 'halted' })] })).toBeNull()
    expect(practicePrice({ ...RUN, markets: [] })).toBeNull()
  })
})

describe('the Practice card (W8)', () => {
  const html = renderToStaticMarkup(<PracticeCard run={RUN} counterparty="none" />)
  const t = text(html)

  it('says the plate, line 1, string 26, the recording and who else trades, in order', () => {
    expect(html).toMatch(/^<section [^>]*data-practice-card/)
    expect(html).toContain('data-practice-plate')
    const order = [
      '>Practice<',
      'Practice game live · MEM @ CLE · Replay',
      PRACTICE_LINE,
      'Recorded Nov 18 ET · MEM @ CLE',
      'MEM 78–84 CLE · Q3 4:12',
      COUNTERPARTY_NONE,
    ].map((s) => html.indexOf(s))
    for (const i of order) expect(i).toBeGreaterThan(0)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(t).toContain('CLE to win 77%')
    expect(t).not.toContain(COUNTERPARTY_AGENT)
    const agent = renderToStaticMarkup(<PracticeCard run={RUN} counterparty="agent" />)
    expect(agent).toContain(COUNTERPARTY_AGENT)
    expect(agent).not.toContain(COUNTERPARTY_NONE)
  })

  it('heads the card with the plate flowing beside line 1', () => {
    expect(html).toMatch(
      /<h2 [^>]*class="[^"]*text-ink[^"]*"[^>]*><span class="mr-1"><span [^>]*data-practice-plate[^>]*>Practice<\/span><\/span> <span>Practice game live · MEM @ CLE · Replay<\/span><\/h2>/,
    )
  })

  it('sets the moving numbers in mono: the score line and the price', () => {
    expect(html).toMatch(/<p class="[^"]*font-mono[^"]*">MEM 78–84 CLE · Q3 4:12<\/p>/)
    expect(html).toMatch(/CLE to win <span class="[^"]*font-mono[^"]*">77%<\/span>/)
  })

  it('ends its play row on a filled ink "Play along", a 44 px plain link to the run', () => {
    expect(PLAY_ALONG).toBe('Play along')
    const a = html.match(/<a ([^>]*)>Play along<\/a>/)
    expect(a).not.toBeNull()
    const attrs = a?.[1] ?? ''
    expect(attrs).toContain('href="/game/practice-401910007p0"')
    for (const c of ['min-h-11', 'bg-ink', 'text-surface', 'rounded-card']) {
      expect(attrs).toContain(c)
    }
    // The score and the price sit beside it, so the card stays short at 375 (§9 fold).
    expect(html.indexOf('Play along')).toBeGreaterThan(html.indexOf('MEM 78–84 CLE'))
    expect(html.indexOf('Play along')).toBeLessThan(html.indexOf(COUNTERPARTY_NONE))
  })

  // §9 at 375 over S5 ("Tonight on the dial · …" wraps, and the board says "All stopped."): the
  // recording, the score and the price stack in one column beside the button, 6 px apart, and who
  // else trades is set at 12 px, so the first board row stays above the 775 fold.
  it('stacks the recording, the score and the price beside the button in one row', () => {
    expect(html).toMatch(/^<section [^>]*class="space-y-1\.5"/)
    expect(html).toMatch(
      /<div class="flex items-center justify-between gap-3"><div class="min-w-0"><p class="font-mono text-12 text-ink-muted">Recorded Nov 18 ET · MEM @ CLE<\/p><div [^>]*data-practice-live[^>]*>[\s\S]*?<\/div><\/div><a [^>]*>Play along<\/a><\/div>/,
    )
    expect(html).toMatch(/<p class="text-12 text-ink-muted" data-counterparty="none">/)
  })

  it('has no Live blue, no style attribute and no script', () => {
    expect(html).not.toMatch(LIVE)
    expect(html).not.toContain('style=')
    expect(html).not.toContain('<script')
  })

  it('is a server component with plain links; only the score and price are a client island', () => {
    const card = read('components', 'chrono', 'practice-card.tsx')
    expect(card).not.toMatch(/^['"]use client['"]/m)
    expect(card).not.toMatch(/from 'next\/link'/)
    expect(card).not.toContain('style=')
    const live = read('components', 'chrono', 'practice-live.tsx')
    expect(live).toMatch(/^'use client'/)
    expect(live).not.toMatch(/from 'next\/link'/)
    expect(live).toContain('api.practice()')
    expect(PRACTICE_POLL_MS).toBe(15_000)
  })
})

describe('the score island polls every 15 s, only while the run is on (W8b)', () => {
  const island = (practice?: PracticeResponse) => {
    stub.practice = practice
    stub.calls = []
    try {
      return renderToStaticMarkup(<PracticeLive run={RUN} />)
    } finally {
      stub.practice = undefined
    }
  }

  it("first renders the server's read, so hydration matches", () => {
    const html = island()
    expect(text(html)).toBe('MEM 78–84 CLE · Q3 4:12CLE to win 77%')
    expect(stub.calls.at(-1)).toEqual(['practice', 15_000])
  })

  it('shows what the last tick read of the same run', () => {
    const later = {
      ...RUN,
      homeScore: 90,
      awayScore: 80,
      clockSecs: 100,
      markets: [market({ price: 0.62 })],
      updatedAt: iso(NOW + 60),
    }
    expect(text(island(resp({ current: later })))).toBe('MEM 80–90 CLE · Q3 1:40CLE to win 62%')
    expect(stub.calls.at(-1)).toEqual(['practice', 15_000])
  })

  it('shows a price that moved with no new game row (the same updatedAt)', () => {
    // A call moves the price between two feed updates: the game row, and its updatedAt, stay.
    const traded = { ...RUN, markets: [market({ price: 0.66 })] }
    expect(traded.updatedAt).toBe(RUN.updatedAt)
    expect(text(island(resp({ current: traded })))).toBe('MEM 78–84 CLE · Q3 4:12CLE to win 66%')
  })

  it('stops at the Final: the last score, no price, and no more ticks', () => {
    const over = {
      ...RUN,
      status: 'final' as const,
      period: 4,
      clockSecs: null,
      homeScore: 101,
      awayScore: 98,
      markets: [market({ status: 'halted', price: 0.99 })],
      updatedAt: iso(NOW + 1_200),
    }
    expect(text(island(resp({ current: over })))).toBe('MEM 98–101 CLE · Final')
    expect(stub.calls.at(-1)).toEqual([null, 15_000])
  })

  it('says nothing once the run is no longer the current one, and stops', () => {
    expect(island(resp({ current: null, nextAt: NOW + 3_600 }))).toBe('')
    expect(stub.calls.at(-1)).toEqual([null, 15_000])
    const next = { ...RUN, id: 'practice-401910008p0' }
    expect(island(resp({ current: next }))).toBe('')
  })
})

const nightFile = (name: string): Night =>
  NightSchema.parse(
    JSON.parse(
      readFileSync(new URL(`../../../tests/fixtures/nights/${name}`, import.meta.url), 'utf8'),
    ),
  )
const REAL = nightFile('2026-11-25.night.json')
const MOVED_NIGHT = nightFile('moved.night.json')
const MIN_OKC = REAL.games.find((g) => g.id === 'nba-401909320') as NightGame
const MOVED = MOVED_NIGHT.games[0] as NightGame
const S2_NOW = at('2026-11-27T08:16:00Z')

describe('the story card shrinks below lg while Practice leads (S6: variant lg-full)', () => {
  const html = renderToStaticMarkup(
    <StoryCard story={{ night: REAL, game: MIN_OKC }} now={S2_NOW} variant="lg-full" />,
  )

  it('keeps the eyebrow, the plate with line 1 and the proof at every width', () => {
    expect(html).toMatch(/^<section [^>]*data-story-card="lg-full"/)
    expect(text(html)).toContain('Wed, Nov 25 on the dial · 2 upsets')
    expect(text(html)).toContain('MIN won 113–106 from 28% before tip-off')
    expect(html).toMatch(/<a href="\/verify\/54WUaz[^"]*" class="inline-flex min-h-11[^"]*"/)
  })

  it('shows the tape, the readout and line 2 from lg only, the wide tape alone', () => {
    expect(html).toMatch(/<figure class="hidden[^"]*lg:block[^"]*" data-story-tape/)
    expect(html.match(/<svg /g)?.filter(Boolean).length).toBe(2) // the tape and the readout dial
    expect(html).toContain('viewBox="0 0 600 132"')
    expect(html).not.toContain('viewBox="0 0 340 96"')
    expect(html).toMatch(/class="hidden items-center gap-4 pt-1 lg:flex story-at-low" data-readout/)
    expect(html).not.toContain('sm:flex')
    expect(html).toMatch(
      /<p class="hidden text-13 text-ink-muted lg:block">The model had MIN at 7%/,
    )
    // The one tape still draws once, through its own mask.
    expect(html).toContain('id="story-tape-wide-model"')
    expect(html).not.toContain('story-tape-narrow')
  })

  it("hides a moved night's tally below lg too", () => {
    const moved = renderToStaticMarkup(
      <StoryCard story={{ night: MOVED_NIGHT, game: MOVED }} now={S2_NOW} variant="lg-full" />,
    )
    expect(moved).toMatch(/<p class="[^"]*hidden[^"]*lg:block[^"]*" data-tally/)
    expect(moved).toMatch(/<p class="[^"]*hidden[^"]*lg:block[^"]*">At the buzzer the price/)
  })

  it('leaves the full and compact cards as they were', () => {
    const full = renderToStaticMarkup(
      <StoryCard story={{ night: REAL, game: MIN_OKC }} now={S2_NOW} />,
    )
    expect(full).toContain('viewBox="0 0 340 96"')
    expect(full).toMatch(/class="hidden items-center gap-4 pt-1 sm:flex story-at-low" data-readout/)
    expect(full).not.toContain('lg:block')
  })
})

describe('the Practice card leads the idle face (S6 placement)', () => {
  const noop = () => {}
  const OK = { stale: false, error: undefined }
  const scheduled = (id: string, away: string, home: string, tip: string, p: number): Game =>
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
    scheduled('nba-401909326', 'MIA', 'NYK', '2026-11-28T00:00:00.000Z', 0.788),
    scheduled('nba-401909327', 'MIL', 'DET', '2026-11-28T00:30:00.000Z', 0.917),
  ]
  const board = (over: Partial<BoardViewProps> = {}) =>
    renderToStaticMarkup(
      <BoardView
        games={friday()}
        portfolio={undefined}
        now={S2_NOW}
        health={OK}
        follows={[]}
        onToggleFollow={noop}
        selectedId={null}
        onSelect={noop}
        hoverId={null}
        onHover={noop}
        idleLead={<p data-test-lead>LEAD</p>}
        idleFace={<p data-test-face>FACE</p>}
        idleFoot={<p data-test-foot>FOOT</p>}
        {...over}
      />,
    )

  it('below lg: the card, the story, the list, then the foot, in the DOM as on screen', () => {
    const html = board()
    const order = ['data-test-lead', 'data-test-face', 'data-board-list', 'data-test-foot'].map(
      (s) => html.indexOf(s),
    )
    expect(order[0]).toBeGreaterThan(0)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // 12 px apart below sm under the lead (16 px without one), 24 px from sm (§9 fold).
    expect(html).toMatch(/^<div class="flex flex-col gap-3 sm:gap-6 lg:grid /)
    expect(board({ idleLead: undefined })).toMatch(
      /^<div class="flex flex-col gap-4 sm:gap-6 lg:grid /,
    )
  })

  it('from lg: the card tops the right column above the list; the story keeps the left', () => {
    const html = board()
    expect(html).toMatch(/lg:grid-rows-\[auto_auto_1fr\]/)
    expect(html).toMatch(/class="min-w-0 lg:col-start-2 lg:row-start-1" data-idle-lead/)
    expect(html).toMatch(
      /class="min-w-0 lg:col-start-1 lg:row-span-2 lg:row-start-1" data-idle-face/,
    )
    expect(html).toMatch(
      /class="min-w-0 space-y-3 lg:col-start-2 lg:row-span-2 lg:row-start-2" data-board-list/,
    )
    expect(html).toMatch(/class="min-w-0 lg:col-start-1 lg:row-start-3" data-idle-foot/)
  })

  it('without a run the idle grid is as before', () => {
    const html = board({ idleLead: undefined })
    expect(html).not.toContain('data-idle-lead')
    expect(html).toMatch(/lg:grid-rows-\[auto_1fr\]/)
    expect(html).toMatch(/class="min-w-0 lg:col-start-1 lg:row-start-1" data-idle-face/)
    expect(html).toMatch(/class="min-w-0 lg:col-start-1 lg:row-start-2" data-idle-foot/)
  })

  it('goes with the face once a market is open (the Night dial takes the slot)', () => {
    const now = at('2026-11-27T23:30:00Z')
    const games = friday().map((g, i) =>
      i === 0
        ? {
            ...g,
            markets: [
              market({ initialPriceBps: 7_884, price: 0.81, priceTs: now - 5, endTs: now + 7_200 }),
            ],
          }
        : g,
    )
    const html = board({ games, now })
    expect(html).not.toContain('data-test-lead')
    expect(html).toContain('role="listbox"')
  })

  it('TonightBoard hands the card over with the face, and drops both together', () => {
    const src = read('components', 'tonight-board.tsx')
    expect(src).toContain('idleLead={gone ? undefined : idleLead}')
    const tonight = (poll?: Game[], now = 0) => {
      stub.games = poll
      stub.now = now
      try {
        return renderToStaticMarkup(
          <WalletProvider>
            <TonightBoard
              initial={{ games: friday(), upcoming: null, now: S2_NOW }}
              state="later"
              idleLead={<p data-test-lead>LEAD</p>}
              idleFace={<p data-test-face>FACE</p>}
              idleFoot={<p data-test-foot>FOOT</p>}
            />
          </WalletProvider>,
        )
      } finally {
        stub.games = undefined
        stub.now = 0
      }
    }
    expect(tonight()).toContain('data-test-lead')
    const now = at('2026-11-27T23:30:00Z')
    const open = friday().map((g, i) =>
      i === 0 ? { ...g, markets: [market({ priceTs: now - 5, endTs: now + 7_200 })] } : g,
    )
    const swapped = tonight(open, now)
    expect(swapped).not.toContain('data-test-lead')
    expect(swapped).not.toContain('data-test-face')
  })
})

describe('the between-runs line (§3 S6, R8)', () => {
  it('is one line: the plate and a 44 px link to the next tip-off (§9 tap targets)', () => {
    const strip = practiceStrip(resp({ current: null, nextAt: NOW + 104 * 60 }), NOW)
    expect(strip).toEqual({
      text: 'Next practice tip-off 10:52 PM ET · in 1 h 44 min',
      href: '/practice',
    })
    const html = renderToStaticMarkup(<PracticeStrip strip={strip} />)
    expect(html).toMatch(
      /^<p class="[^"]*" data-practice-strip="true"><span [^>]*data-practice-plate[^>]*>Practice<\/span><a [^>]*class="inline-flex min-h-11 items-center underline underline-offset-4"[^>]*>Next practice tip-off 10:52 PM ET · in 1 h 44 min<\/a><\/p>$/,
    )
    expect(html).not.toMatch(LIVE)
  })
})

describe('/ wires Practice per state (§3 S6, §7 page.tsx)', () => {
  const page = read('app', 'page.tsx')

  it('leads the idle face with the card only while a run is on and the face is idle', () => {
    expect(page).toMatch(/const run = idle \? practiceLive\(practice, initial\.now\) : null/)
    expect(page).toMatch(/<PracticeCard run=\{run\} counterparty=\{practice\.counterparty\} \/>/)
    expect(page).toMatch(/<TonightBoard[^>]*idleLead=\{lead\}/s)
    expect(page).toContain("variant={run ? 'lg-full' : 'full'}")
  })

  it('keeps the between-runs line in the foot, and drops it there while the card leads', () => {
    expect(page).toContain('strip={run ? null : strip}')
    // S3/S4 (or after the swap) the open foot keeps R8's one line, live or between runs.
    expect(page).toMatch(/openFoot=\{[\s\S]*<PracticeStrip strip=\{strip\}/)
  })
})
