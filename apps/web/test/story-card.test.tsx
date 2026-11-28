// First screen, slice 4 "Story card" (first-screen spec §3 S1/S2/S5, §5 C7-C15, §7 W2, W3, W5,
// §11 row 4): the static story card (full and compact), the idle face in the board's dial slot,
// the A4 rows under the story, and the page's layout per state. Real ET 11-25 data as GET
// /nights/2026-11-25 serves it (packages/api/test/nights.test.ts pins the file), and the synthetic
// moved night beside it. Pure markup: no API, no DB.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Game, type Night, type NightGame, NightSchema } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BoardView, type BoardViewProps } from '../components/chrono/board-view'
import { HowItWorks } from '../components/chrono/hero'
import { rotateAbout } from '../components/chrono/needle'
import { IdleFoot, SIGN_OFF, StoryCard } from '../components/story-card'
import { at, game, market } from '../lib/chrono/fixtures'
import { priceToAngle } from '../lib/chrono/geometry'
import { screenState } from '../lib/server/first-screen'
import {
  currentNight,
  LAST_NIGHT_ROWS,
  lastNightHeader,
  lastNightRowText,
  rowsOfNight,
} from '../lib/server/last-night'
import { STORY_PENDING } from '../lib/server/story'

const WEB = join(import.meta.dirname, '..')
const read = (...p: string[]) => readFileSync(join(WEB, ...p), 'utf8')

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
// Fri, Nov 27, 3:16 AM ET: the audited judge visit (spec §3 S2).
const S2_NOW = at('2026-11-27T08:16:00Z')

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')

/** Any Live blue class: none belongs on the story, the A4 rows or the foot (§9). */
const LIVE = /\b(text|bg|stroke|fill|border)-live\b/

describe('the A4 rows come from the story night, the story game dropped (W3, C14)', () => {
  it('keeps R10 story order and drops MIN @ OKC: CHI, POR, PHI, BKN, HOU', () => {
    const rows = rowsOfNight(REAL, MIN_OKC.id)
    expect(rows.map((r) => r.winner)).toEqual(['CHI', 'POR', 'PHI', 'BKN', 'HOU'])
    expect(rows).toHaveLength(LAST_NIGHT_ROWS - 1)
    expect(rows.some((r) => r.id === MIN_OKC.id)).toBe(false)
    expect(lastNightRowText(rows[0] as (typeof rows)[0])).toBe('CHI 107–105 CHA · opened 26%')
    // Flat night: no row says "closed".
    for (const r of rows) expect(lastNightRowText(r)).not.toContain('closed')
  })

  it('says "closed" on a row only when /nights calls its market moved', () => {
    const night = { ...REAL, games: [...REAL.games, MOVED] }
    const rows = rowsOfNight(night, MIN_OKC.id)
    const nyk = rows.find((r) => r.id === MOVED.id)
    expect(nyk && lastNightRowText(nyk)).toBe('NYK 110–100 MIA · opened 60% · closed 81%')
  })
})

describe('the night that just ended is the story night in S5 (W3)', () => {
  // Sat, Nov 28, 1:30 AM ET: every game of the ET night 11-27 is final.
  const now = at('2026-11-28T06:30:00Z')
  const fin = (id: string, home: string, away: string, hs: number, as: number, bps: number) =>
    game({
      id,
      home,
      away,
      homeScore: hs,
      awayScore: as,
      status: 'final',
      period: 4,
      clockSecs: null,
      scheduledTipoff: '2026-11-28T00:30:00.000Z',
      markets: [market({ pubkey: `Mkt${id}`, status: 'proposed', initialPriceBps: bps })],
    })

  it("builds tonight's night from the board's own games, and names it as tonight", () => {
    const games = [
      fin('nba-1', 'NYK', 'MIA', 100, 104, 7_000),
      fin('nba-2', 'DET', 'MIL', 99, 90, 6_000),
    ]
    const night = currentNight(games, now)
    expect(night?.date).toBe('2026-11-27')
    expect(night?.upsets).toBe(1)
    expect(night?.rows.map((r) => r.winner)).toEqual(['MIA', 'DET'])
    expect(night && lastNightHeader(night, now)).toBe('Tonight · Fri, Nov 27 · 1 upset')
    expect(currentNight([], now)).toBeNull()
  })
})

describe('the server picks the first-screen state (§3)', () => {
  const tip = '2026-11-28T00:00:00.000Z'
  const sched = game({
    id: 'nba-9',
    status: 'scheduled',
    homeScore: 0,
    awayScore: 0,
    period: 0,
    clockSecs: null,
    scheduledTipoff: tip,
    markets: [],
  })

  it('S2 later, S1 rest, S3 pre-open, S4 live and S5 after', () => {
    expect(screenState([sched], S2_NOW)).toBe('later')
    expect(screenState([], S2_NOW)).toBe('rest')
    expect(screenState(undefined, S2_NOW)).toBe('later')
    const preNow = at('2026-11-27T23:30:00Z')
    const open = {
      ...sched,
      markets: [market({ initialPriceBps: 7_000, price: 0.7, endTs: at('2026-11-28T05:00:00Z') })],
    }
    expect(screenState([open], preNow)).toBe('preopen')
    const liveNow = at('2026-11-28T00:40:00Z')
    expect(screenState([{ ...open, status: 'live', period: 1, clockSecs: 400 }], liveNow)).toBe(
      'live',
    )
    const over = game({
      ...open,
      status: 'final',
      homeScore: 99,
      awayScore: 90,
      period: 4,
      markets: [market({ status: 'proposed', initialPriceBps: 7_000 })],
    })
    expect(screenState([over], at('2026-11-28T06:30:00Z'))).toBe('after')
  })
})

describe('the full story card on real ET 11-25 data (W2, C7-C12, G1)', () => {
  const html = renderToStaticMarkup(
    <StoryCard story={{ night: REAL, game: MIN_OKC }} now={S2_NOW} />,
  )
  const t = text(html)

  it('heads with the dated eyebrow and tells the upset from 28%', () => {
    expect(html).toMatch(
      /<h2 [^>]*class="[^"]*uppercase[^"]*"[^>]*>Last game night · Wed, Nov 25<span class="hidden lg:inline"> · 2 upsets<\/span><\/h2>/,
    )
    expect(html).toContain('data-story="Upset"')
    expect(t).toContain('MIN won 113–106 from 28% before tip-off')
    expect(t).toContain('The model had MIN at 7% at Q3 5:41, down 63–74.')
  })

  it('draws the tape twice, 340×96 below sm and 600×132 from sm, with its marks (C10)', () => {
    expect(html.match(/viewBox="0 0 340 96"/g)).toHaveLength(1)
    expect(html.match(/viewBox="0 0 600 132"/g)).toHaveLength(1)
    expect(t).toContain('MIN @ OKC · MIN to win▲ Horagon model')
    expect(t).not.toContain('— Price')
    expect(html.match(/>opened 28%</g)).toHaveLength(2)
    expect(html.match(/>Final 113–106</g)).toHaveLength(2)
    expect(html.match(/>7%</g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4'])
      expect(html.match(new RegExp(`>${q}<`, 'g'))).toHaveLength(2)
    expect(html.match(/data-tape-model/g)).toHaveLength(2)
    expect(html.match(/data-tape-low/g)).toHaveLength(2)
    // A flat night draws no price line.
    expect(html).not.toContain('data-tape-price')
  })

  it('puts "opened 28%" under its dot where the line climbs off the open, and haloes every label', () => {
    for (const m of html.matchAll(
      /<circle cx="([\d.]+)" cy="([\d.]+)" r="2.5"[^>]*><\/circle><text x="[\d.]+" y="([\d.]+)"[^>]*>opened 28%/g,
    )) {
      expect(Number(m[3])).toBeGreaterThan(Number(m[2]))
    }
    expect(html.match(/<circle cx="[\d.]+" cy="[\d.]+" r="2.5"/g)).toHaveLength(2)
    expect(html.match(/<text [^>]*paint-order="stroke"/g)).toHaveLength(2 * (4 + 3))
  })

  it('rests a readout on the low with a 96 px dial and an ink ▲ from sm (C11)', () => {
    expect(html).toMatch(/class="[^"]*hidden[^"]*sm:flex[^"]*" data-readout/)
    expect(t).toContain('Q3 5:41 · 63–74')
    expect(t).toContain('MIN to win 7%')
    expect(html).toMatch(
      /<p [^>]*class="[^"]*font-mono[^"]*text-\[28px\][^"]*"[^>]*>MIN to win 7%<\/p>/,
    )
    expect(html).toContain('data-model')
    // A model low: the ▲ alone, no price needle on the readout's dial.
    expect(html).not.toContain('data-needle')
    expect(html).toMatch(
      /<div class="[^"]*size-24[^"]*\[&amp;&gt;svg\]:size-full[^"]*"><svg viewBox="0 0 100 100"/,
    )
  })

  it('links the result to /verify with string 20 in a 44 px plain link (C12)', () => {
    expect(html).toMatch(
      new RegExp(
        `<a href="/verify/${MIN_OKC.market}" class="[^"]*min-h-11[^"]*"[^>]*>Result on-chain · MIN won · Check it yourself <span aria-hidden="true">→</span></a>`,
      ),
    )
  })

  // §9 at 375: the plate flows with line 1's words (no flex row), so a long line wraps beside the
  // plate ("[COMEBACK] NYK won 121–102 after the / model had them at 8% in Q2", 2 lines, not 3).
  it('flows the plate with the words of line 1, a space apart, no flex row', () => {
    const p = html.match(/<p class="([^"]*)"><span class="[^"]*"><span [^>]*data-story="Upset"/)
    expect(p).not.toBeNull()
    expect((p?.[1] ?? '').split(' ')).not.toContain('flex')
    expect(text(html)).toContain('Upset MIN won 113–106 from 28% before tip-off')
  })

  it('says nothing about a price: no "closed", no tally, no buzzer line', () => {
    expect(t).not.toContain('closed')
    expect(t).not.toContain('calls')
    expect(t).not.toContain('At the buzzer')
    expect(html).not.toContain('data-tally')
  })

  it('has no Live blue, no style attribute and no script', () => {
    expect(html).not.toMatch(LIVE)
    expect(html).not.toContain('style=')
    expect(html).not.toContain('<script')
    expect(html.startsWith('<section')).toBe(true)
    expect(html).toMatch(/^<section [^>]*data-story-card="full"/)
  })
})

describe('the full story card on the moved night (C8, C8t, C10)', () => {
  const html = renderToStaticMarkup(
    <StoryCard story={{ night: MOVED_NIGHT, game: MOVED }} now={S2_NOW} />,
  )
  const t = text(html)

  it('draws the price line and says the buzzer price and who called', () => {
    expect(html.match(/data-tape-price/g)).toHaveLength(2)
    expect(t).toContain('MIA @ NYK · NYK to win▲ Horagon model  — Price')
    expect(t).toContain('At the buzzer the price had NYK at 81%.')
    expect(t).toContain('14 calls · 2 by fans · 12 by the reference agent')
    expect(html).toMatch(/<a href="\/agent"[^>]*>reference agent<\/a>/)
    expect(html).not.toMatch(LIVE)
  })

  // §9 at 375: every tap target is at least 44 px. The tally's link is one atomic 44 px box, so
  // "reference agent" never splits across the wrap; the tally is set in the sans, so "14 calls ·
  // 2 by fans · 12 by the reference agent" (263 px; 281 px with 3-digit counts) fits one line of
  // the 343 px column.
  it("makes the tally's reference agent one 44 px link that never splits (§9)", () => {
    const link = html.match(/<a href="\/agent" class="([^"]*)"[^>]*>reference agent<\/a>/)
    expect(link).not.toBeNull()
    const cls = (link?.[1] ?? '').split(' ')
    for (const c of ['inline-flex', 'min-h-11', 'items-center', 'whitespace-nowrap'])
      expect(cls).toContain(c)
    const tally = html.match(/<p class="([^"]*)" data-tally="true">/)?.[1] ?? ''
    expect(tally).not.toBe('')
    expect(tally.split(' ')).not.toContain('font-mono')
  })

  // A moved card carries more rows than a flat one (the legend, line 2's buzzer price, the tally),
  // so its 375 tape is 12 px shorter (340×84); from sm it keeps 600×132.
  it('draws the 375 tape 340×84 on a moved card, 600×132 from sm (§9)', () => {
    expect(html.match(/viewBox="0 0 340 84"/g)).toHaveLength(1)
    expect(html.match(/viewBox="0 0 600 132"/g)).toHaveLength(1)
    expect(html).not.toContain('viewBox="0 0 340 96"')
    // The top band stays 16 units, so "Final 110–100" still sits above a line that ends near the
    // top, clear of the price line under it.
    const narrow = html.match(/<svg viewBox="0 0 340 84"[\s\S]*?<\/svg>/)?.[0] ?? ''
    const final = narrow.match(/<text x="[\d.]+" y="([\d.]+)"[^>]*>Final 110–100<\/text>/)
    expect(final).not.toBeNull()
    expect(Number(final?.[1])).toBeLessThan(16)
  })

  // §9 at 375: the first board row stays above the fold on a moved night. Line 2, the tally's
  // 44 px row and the 44 px proof sit flush (the tally row's own height is the gap), and the
  // legend shares the caption's row where both fit (in the sans, 8 px apart).
  it('stacks line 2, the tally and the proof flush, the legend beside the caption (§9)', () => {
    expect(html).toMatch(
      /<p class="[^"]*\bmb-0\b[^"]*">At the buzzer the price had NYK at 81%\.<\/p>/,
    )
    expect(html).toMatch(/<p class="[^"]*\bmb-0\b[^"]*" data-tally="true">/)
    const caption = html.match(
      /<figcaption class="([^"]*)"><span>[^<]*<\/span><span( class="([^"]*)")?>/,
    )
    expect(caption).not.toBeNull()
    expect((caption?.[1] ?? '').split(' ')).toContain('gap-x-2')
    expect(caption?.[3] ?? '').not.toContain('font-mono')
  })

  // C11: a low from prices reads "price", so its dial draws the price's needle, not the model's
  // ▲ (one meaning per glyph: ▲ is the model, and the legend under it says so). Trading stopped,
  // so the needle is ash, never Live blue.
  it('rests the readout on the price low with an ash price needle and no model ▲ (C11)', () => {
    const readout = html.match(
      /<div [^>]*data-readout[^>]*>[\s\S]*?<\/svg>[\s\S]*?<\/div><\/div>/,
    )?.[0]
    expect(readout).toBeDefined()
    const r = readout ?? ''
    expect(text(r)).toContain('Q2 6:00 · 38–47')
    expect(text(r)).toContain('NYK to win 35%')
    expect(text(r)).toMatch(/price$/)
    expect(r).not.toContain('data-model')
    expect(r).toContain(
      `<g transform="${rotateAbout(priceToAngle(0.35), 50)}" class="stroke-ash-400" data-needle="price">`,
    )
    expect(r).not.toMatch(LIVE)
    // The whole card: no model ▲ drawn for a price low.
    expect(html).not.toContain('data-model')
  })
})

describe('the compact story (S3/S4, a missing tape)', () => {
  const html = renderToStaticMarkup(
    <StoryCard story={{ night: REAL, game: MIN_OKC }} now={S2_NOW} variant="compact" />,
  )

  it('keeps the eyebrow, the plate and line 1 and the proof, and drops tape, readout and line 2', () => {
    const t = text(html)
    expect(t).toContain('Last game night · Wed, Nov 25 · 2 upsets')
    expect(t).toContain('MIN won 113–106 from 28% before tip-off')
    expect(t).toContain('Result on-chain · MIN won · Check it yourself')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('data-readout')
    expect(t).not.toContain('The model had')
    expect(html).toMatch(/^<section [^>]*data-story-card="compact"/)
  })
})

describe('the proof line follows the resolution (C12)', () => {
  it('says string 19 as plain words while no result is on chain', () => {
    const open = { ...MIN_OKC, resolution: { ...MIN_OKC.resolution, status: 'open' as const } }
    const html = renderToStaticMarkup(
      <StoryCard story={{ night: REAL, game: open }} now={S2_NOW} />,
    )
    expect(text(html)).toContain(STORY_PENDING)
    expect(html).not.toContain('href="/verify/')
  })
})

describe("the idle face's foot (C13, C15)", () => {
  const rows = rowsOfNight(REAL, MIN_OKC.id)
  const html = renderToStaticMarkup(<IdleFoot rows={rows} date={REAL.date} strip={null} />)
  const t = text(html)

  it('folds the A4 rows under "5 more games from Wed, Nov 25" below lg, and lists them from lg', () => {
    expect(html).toMatch(
      /<details class="[^"]*lg:hidden[^"]*"[^>]*><summary class="[^"]*min-h-11[^"]*"[^>]*><span aria-hidden="true"[^>]*>▸<\/span>5 more games from Wed, Nov 25 · 1 upset<\/summary>/,
    )
    expect(html).toMatch(/class="hidden[^"]*lg:block[^"]*"[^>]*data-last-night-rows/)
    expect(html.match(/CHI 107–105 CHA/g)).toHaveLength(2)
    expect(html.match(/href="\/study"/g)).toHaveLength(2)
    expect(html).not.toMatch(LIVE)
  })

  it('folds "How it works" here below sm, and signs off with "Game time, kept."', () => {
    expect(SIGN_OFF).toBe('Game time, kept.')
    expect(t.trimEnd().endsWith('Game time, kept.')).toBe(true)
    expect(html).toMatch(/<details class="[^"]*sm:hidden[^"]*"[^>]*data-how/)
    // The order at 375: How it works, the more games, then the sign-off.
    expect(html.indexOf('data-how')).toBeLessThan(html.indexOf('more games from'))
  })

  it('carries the Practice line between runs, before the sign-off', () => {
    const withStrip = renderToStaticMarkup(
      <IdleFoot
        rows={rows}
        date={REAL.date}
        strip={{ text: 'Next practice tip-off 5:00 AM ET · in 1 h 44 min', href: '/practice' }}
      />,
    )
    expect(withStrip.indexOf('data-practice-strip')).toBeGreaterThan(
      withStrip.indexOf('more games from'),
    )
    expect(withStrip.indexOf('data-practice-strip')).toBeLessThan(withStrip.indexOf(SIGN_OFF))
  })

  it('skips the rows with none, and says "1 more game" for one', () => {
    const none = renderToStaticMarkup(<IdleFoot rows={[]} date={REAL.date} strip={null} />)
    expect(none).not.toContain('more game')
    const one = renderToStaticMarkup(
      <IdleFoot rows={rows.slice(0, 1)} date={REAL.date} strip={null} />,
    )
    expect(text(one)).toContain('1 more game from Wed, Nov 25')
  })
})

describe('the How it works fold moves below the list at 375 (S2 layout)', () => {
  it('hides the hero copy below sm; the foot copy shows only there', () => {
    expect(renderToStaticMarkup(<HowItWorks className="max-sm:hidden" />)).toMatch(
      /^<details class="[^"]*max-sm:hidden/,
    )
    expect(read('components', 'chrono', 'hero.tsx')).toContain(
      '<HowItWorks className="max-sm:hidden"',
    )
  })
})

describe('the idle face takes the dial slot while no market is open (W5)', () => {
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
        idleFace={<p data-test-face>FACE</p>}
        idleFoot={<p data-test-foot>FOOT</p>}
        {...over}
      />,
    )

  it('S2: the face leads, then the list, then the foot; no Night dial', () => {
    const html = board()
    const face = html.indexOf('data-test-face')
    const list = html.indexOf('data-board-list')
    const foot = html.indexOf('data-test-foot')
    expect(face).toBeGreaterThan(0)
    expect(face).toBeLessThan(list)
    expect(list).toBeLessThan(foot)
    expect(html).not.toContain('role="listbox"')
    expect(html).not.toContain('viewBox="0 0 200 200"')
    // From lg: face and foot in the left column, the list right across both rows.
    expect(html).toMatch(/lg:grid-cols-\[34rem_minmax\(0,1fr\)\]/)
    expect(html).toMatch(/class="[^"]*lg:col-start-1[^"]*lg:row-start-1[^"]*" data-idle-face/)
    expect(html).toMatch(/class="[^"]*lg:col-start-1[^"]*lg:row-start-2[^"]*" data-idle-foot/)
  })

  // §9 at 375: "TONIGHT · FRI NOV 27 · 11 GAMES" leaves no room for "☆ Follow teams" beside it,
  // so below sm Follow shares the count line's row instead of a 44 px row of its own (32 px back
  // for the first board row). From sm the count keeps its own line under the heading row, as before.
  it('S2: below sm, Follow shares the count row; from sm the count has its own line', () => {
    const html = board()
    const row = html.match(
      /<div class="([^"]*)"><h2 class="([^"]*)">[^<]*<\/h2><details class="([^"]*)" data-follow="true">[\s\S]*?<\/details><p class="([^"]*)" data-count="true">First market opens in [^<]*<\/p><\/div>/,
    )
    expect(row).not.toBeNull()
    const [, wrap, h2, follow, count] = (row ?? []).map((c) => (c ?? '').split(' '))
    expect(wrap).toEqual(expect.arrayContaining(['flex', 'flex-wrap', 'sm:gap-y-3']))
    expect(h2).toContain('max-sm:basis-full')
    expect(follow).toContain('max-sm:order-last')
    expect(count).toContain('sm:basis-full')
    // Below sm the face, the list and the foot stand 16 px apart (24 px from sm).
    expect(html).toMatch(/^<div class="flex flex-col gap-4 sm:gap-6 lg:grid lg:grid-cols-\[34rem/)
  })

  it('S1: with no count line the heading row is as before', () => {
    const html = board({ games: [], now: at('2026-11-26T09:00:00Z') })
    expect(html).not.toContain('max-sm:basis-full')
    expect(html).not.toContain('max-sm:order-last')
  })

  it('S3: once a market is open the Night dial takes the slot back and the face goes', () => {
    const now = at('2026-11-27T23:30:00Z')
    const games = friday().map((g, i) =>
      i === 0
        ? {
            ...g,
            markets: [
              market({
                initialPriceBps: 7_884,
                price: 0.81,
                priceTs: now - 5,
                endTs: at('2026-11-28T05:32:00Z'),
              }),
            ],
          }
        : g,
    )
    const html = board({ games, now })
    expect(html).not.toContain('data-test-face')
    expect(html).not.toContain('data-test-foot')
    expect(html).toContain('role="listbox"')
    // The count line holds "Pick a game": Follow keeps its DOM place, so focus follows the eye.
    expect(html).toContain('max-sm:basis-full')
    expect(html).not.toContain('max-sm:order-last')
  })

  it('without an idle face the board keeps its dial, as before', () => {
    const html = board({ idleFace: undefined, idleFoot: undefined })
    expect(html).toContain('role="listbox"')
  })

  it('S1: the rest card says the day and the count in two lines in the list column', () => {
    const now = at('2026-11-26T09:00:00Z')
    const html = board({
      games: [],
      now,
      upcoming: { tip: at('2026-11-28T00:00:00Z'), count: 4 },
    })
    expect(html).toMatch(
      /data-rest-card[^>]*><p class="[^"]*text-13 text-ink"[^>]*>The dial rests until Fri, Nov 27\.<\/p><p class="[^"]*text-13 text-ink-muted"[^>]*>4 games, first tip-off in 39 h\.<\/p>/,
    )
    // The rest card replaces "Next games: …"; the calendar button follows it.
    expect(html).not.toContain('data-next')
    expect(html.indexOf('data-rest-card')).toBeLessThan(html.indexOf('data-calendar'))
    expect(html).toContain('data-test-face')
  })

  it('S1 with no next games known: one line, "No NBA games in the next 24 hours."', () => {
    const html = board({ games: [], now: at('2026-11-26T09:00:00Z') })
    expect(html).toMatch(
      /data-rest-card[^>]*><p [^>]*>No NBA games in the next 24 hours\.<\/p><\/div>/,
    )
  })
})

describe('/ lays out the first screen per state (§7 page.tsx)', () => {
  const page = read('app', 'page.tsx')

  it('loads the story night after the first four, under what is left of the budget', () => {
    expect(page).toMatch(
      /Promise\.all\(\[\s*initialBoard\(\),\s*initialLastNight\(\),\s*initialPractice\(\),\s*initialRecord\(\),?\s*\]\)/,
    )
    // The night the story tells (S5: the night that just ended, from currentNight) and the layout
    // per state are firstScreen's, pinned by behaviour in first-screen.test.tsx.
    expect(page).toContain('const told = storyNight(initial.games, initial.now, lastNight)')
    expect(page).toMatch(/initialStory\(\s*told\.date,/)
    expect(page).toContain(
      'firstScreen({ games: initial.games, now: initial.now, lastNight, story, practice })',
    )
    expect(read('lib', 'server', 'first-screen.ts')).toContain('currentNight(')
  })

  it('passes the story to the hero, the rail and the board, and the face only while idle', () => {
    expect(page).toContain(
      'moved={heroMoved(initial.games, initial.now, story?.game.moved ?? false)}',
    )
    expect(page).toMatch(
      /proofMarket=\{story\?\.game\.market \?\? night\?\.rows\[0\]\?\.market \?\? null\}/,
    )
    expect(page).toMatch(/<TonightBoard[^>]*idleFace=\{face\}[^>]*idleFoot=\{foot\}/s)
    expect(page).not.toContain('second=')
    expect(page.indexOf('<Hero')).toBeLessThan(page.indexOf('<ProofRail'))
    expect(page.indexOf('<ProofRail')).toBeLessThan(page.indexOf('<TonightBoard'))
  })

  it('in S3/S4 puts the compact story under the board, then Practice, then the agent note', () => {
    const board = page.indexOf('<TonightBoard')
    const compact = page.indexOf('variant="compact"')
    expect(compact).toBeGreaterThan(board)
    expect(page.indexOf('<PracticeStrip', compact)).toBeGreaterThan(compact)
    expect(page.lastIndexOf('<AgentNote />')).toBeGreaterThan(
      page.indexOf('<PracticeStrip', compact),
    )
  })

  it('keeps the story card a server component with plain links only', () => {
    const src = read('components', 'story-card.tsx')
    expect(src).not.toMatch(/^['"]use client['"]/m)
    expect(src).not.toMatch(/from 'next\/link'/)
    expect(src).not.toContain('style=')
  })
})
