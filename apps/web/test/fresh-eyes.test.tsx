// The fresh-eyes notes on the first screen (first-screen spec §9, the 10-second test): three cold
// readers passed it but stumbled on nine points. Each describe pins one note's fix. Real ET 11-25
// data as GET /nights/2026-11-25 serves it, the synthetic moved night, and Friday's real slate.
// Pure markup and words: no API, no DB.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Game, type Night, type NightGame, NightSchema } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BOARD_NOTE } from '../components/chrono/board-view'
import { DialRow } from '../components/chrono/dial-row'
import { MiniDial } from '../components/chrono/mini-dial'
import { ProofRail } from '../components/proof-rail'
import { IdleFoot, StoryCard } from '../components/story-card'
import { boardItem, boardModel, rowWords, scoreLine, sinceOpen } from '../lib/chrono/board'
import { at, game, market } from '../lib/chrono/fixtures'
import { arcPath, MIN_ANGLE, priceToAngle } from '../lib/chrono/geometry'
import { inMinutes, roughIn } from '../lib/chrono/time'
import { lastNightHeader, rowsOfNight } from '../lib/server/last-night'
import { storyLines, tapeModel } from '../lib/server/story'
import { SET_UP_WALLET } from '../lib/wallet-copy'

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

/** Friday's first game (production API, 2026-11-27): NYK 78.8% by the model, no market yet. */
const nykPreOpen = (): Game =>
  game({
    id: 'nba-401909326',
    away: 'MIA',
    home: 'NYK',
    status: 'scheduled',
    homeScore: 0,
    awayScore: 0,
    period: 0,
    clockSecs: null,
    scheduledTipoff: '2026-11-28T00:00:00.000Z',
    modelProb: 0.788449691204833,
    markets: [],
  })

describe('note 1: the eyebrow counts only the upsets the screen shows with it', () => {
  const full = renderToStaticMarkup(
    <StoryCard story={{ night: REAL, game: MIN_OKC }} now={S2_NOW} />,
  )
  const h2 = (html: string) => /<h2 [^>]*>([\s\S]*?)<\/h2>/.exec(html)?.[1] ?? ''

  it('keeps the night count out of the full card below lg, where the other rows are folded', () => {
    const head = h2(full)
    expect(text(head)).toBe('Last game night · Wed, Nov 25 · 2 upsets')
    // Below lg only the story's own plate shows, so the count waits for lg, where the A4 rows
    // with their UPSET plates sit under the story.
    expect(head).toMatch(/<span class="hidden lg:inline"> · 2 upsets<\/span>$/)
    const lgFull = renderToStaticMarkup(
      <StoryCard story={{ night: REAL, game: MIN_OKC }} now={S2_NOW} variant="lg-full" />,
    )
    expect(h2(lgFull)).toMatch(/<span class="hidden lg:inline"> · 2 upsets<\/span>$/)
  })

  it('keeps the count at every width on the compact card, whose rows list the other upset', () => {
    const rows = rowsOfNight(REAL, MIN_OKC.id)
    const compact = renderToStaticMarkup(
      <StoryCard
        story={{ night: REAL, game: MIN_OKC }}
        now={S2_NOW}
        variant="compact"
        rows={rows}
      />,
    )
    expect(h2(compact)).toBe('Last game night · Wed, Nov 25 · 2 upsets')
    expect(compact).toContain('UPSET</span>')
  })

  it('says where the other upset is on the folded rows: "5 more games … · 1 upset"', () => {
    const rows = rowsOfNight(REAL, MIN_OKC.id)
    const html = renderToStaticMarkup(<IdleFoot rows={rows} date={REAL.date} strip={null} />)
    expect(html).toMatch(/▸<\/span>5 more games from Wed, Nov 25 · 1 upset<\/summary>/)
    const calm = rows.map((r) => ({ ...r, upset: false }))
    const none = renderToStaticMarkup(<IdleFoot rows={calm} date={REAL.date} strip={null} />)
    expect(none).toMatch(/▸<\/span>5 more games from Wed, Nov 25<\/summary>/)
    const two = rows.map((r, i) => ({ ...r, upset: i < 2 }))
    expect(renderToStaticMarkup(<IdleFoot rows={two} date={REAL.date} strip={null} />)).toMatch(
      /5 more games from Wed, Nov 25 · 2 upsets<\/summary>/,
    )
  })
})

describe('note 2: the first "model" a reader meets says it is the Horagon model', () => {
  it('names it in the desktop rail, the first "model" from sm up', () => {
    const html = renderToStaticMarkup(
      <ProofRail record={{ markets: 12, final: 12 }} proofMarket={MIN_OKC.market} />,
    )
    const rail = text(html)
    expect(rail).toContain('How the Horagon model is checked')
    expect(rail.indexOf('model')).toBe(rail.indexOf('Horagon model') + 'Horagon '.length)
  })

  it('names it in the tape legend, the first "model" at 375, with no repeat in the caption', () => {
    const flat = tapeModel(MIN_OKC, { w: 340, h: 96 })
    expect(flat.caption).toBe('MIN @ OKC · MIN to win')
    expect(flat.legend).toEqual(['▲ Horagon model'])
    const moved = tapeModel(MOVED, { w: 340, h: 84 })
    expect(moved.caption).toBe('MIA @ NYK · NYK to win')
    expect(moved.legend).toEqual(['▲ Horagon model', '— Price'])
    const html = renderToStaticMarkup(
      <StoryCard story={{ night: REAL, game: MIN_OKC }} now={S2_NOW} />,
    )
    const t = text(html)
    expect(t.indexOf('model')).toBe(t.indexOf('Horagon model') + 'Horagon '.length)
  })

  it('names it in the board note, the legend for the rows\' "79% model"', () => {
    expect(BOARD_NOTE).toBe(
      "Each market opens 60 min before tip-off at the Horagon model's chance at that time.",
    )
  })
})

describe('note 3: a trading row says the opening price beside its move', () => {
  it('reads "−12 · opened 79%" for production\'s NYK move (7884 bps → 66.53%)', () => {
    expect(sinceOpen(0.6653, 7_884)).toBe('−12 · opened 79%')
    expect(sinceOpen(0.81, 7_900)).toBe('+2 · opened 79%')
    expect(sinceOpen(0.794, 7_900)).toBe('+0.4 · opened 79%')
    expect(sinceOpen(0.79, 7_900)).toBe('opening price')
  })

  it('makes the shown numbers add up: the move is between the two whole % on the row', () => {
    // 78.5% shows as 79%, 66.4% as 66%: the row reads 66%, so the move reads −13, not −12.1's −12.
    expect(sinceOpen(0.664, 7_850)).toBe('−13 · opened 79%')
    // Under one shown point it keeps one decimal, never "+1.0" beside an unchanged whole %.
    expect(sinceOpen(0.7946, 7_850)).toBe('+0.9 · opened 79%')
  })

  it('keeps U+2212 and adds no unit word ("pts" reads as a basketball score)', () => {
    const note = sinceOpen(0.6, 7_900)
    expect(note.startsWith('−')).toBe(true)
    expect(note).not.toMatch(/pts|points/)
  })

  it('puts it on the row, with the close from sm up', () => {
    const now = at('2026-11-25T02:08:00Z')
    const live = boardItem(game({ markets: [market({ initialPriceBps: 7_500 })] }), undefined, now)
    expect(rowWords(live, now).note).toBe('+2 · opened 75%')
    const html = renderToStaticMarkup(<DialRow item={live} now={now} />)
    expect(html).toContain('+2 · opened 75%<span class="hidden sm:inline"> · closes by 10:10 PM ET')
  })
})

describe('note 4: a pre-open MiniDial draws the model chance, dashed: not open yet', () => {
  const arcOf = (html: string) => /<path d="([^"]*)"[^>]*data-model-arc/.exec(html)?.[1]

  it('draws a dashed ink arc from 0% to the model, in place of the full time ring', () => {
    const html = renderToStaticMarkup(
      <MiniDial price={null} model={0.79} timeLeft={1} state="pre" />,
    )
    expect(arcOf(html)).toBe(arcPath(50, 50, 42, MIN_ANGLE, priceToAngle(0.79)))
    expect(html).toMatch(
      /<path [^>]*stroke-dasharray="[\d. ]+"[^>]*class="stroke-ink"[^>]*data-model-arc/,
    )
    // No full ring that reads as an empty clock, and the ▲ still ends the arc.
    expect(html).not.toContain('data-ring')
    expect(html).toContain('data-model')
    expect(html).not.toMatch(/\b(stroke|fill|text)-live\b/)
  })

  it('gives each model its own shape', () => {
    const a = arcOf(
      renderToStaticMarkup(<MiniDial price={null} model={0.29} timeLeft={1} state="pre" />),
    )
    const b = arcOf(
      renderToStaticMarkup(<MiniDial price={null} model={0.92} timeLeft={1} state="pre" />),
    )
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).not.toBe(b)
  })

  it("leaves priced dials, dials with no model and the story readout's dial as they were", () => {
    const priced = renderToStaticMarkup(
      <MiniDial price={0.6} model={0.79} timeLeft={0.5} state="live" />,
    )
    expect(priced).not.toContain('data-model-arc')
    expect(priced).toContain('data-ring')
    const none = renderToStaticMarkup(<MiniDial price={null} timeLeft={1} state="pre" />)
    expect(none).not.toContain('data-model-arc')
    expect(none).toContain('data-ring')
    const readout = renderToStaticMarkup(
      <MiniDial price={null} model={0.07} timeLeft={0} state="resolved" />,
    )
    expect(readout).not.toContain('data-model-arc')
  })

  it('draws no arc on a game that started with no market: it will not open', () => {
    const now = at('2026-11-28T06:30:00Z')
    const over = game({
      ...nykPreOpen(),
      status: 'final',
      homeScore: 108,
      awayScore: 101,
      period: 4,
      clockSecs: 0,
    })
    const item = boardItem(over, undefined, now)
    expect(item.state).toBe('pre')
    expect(rowWords(item, now).note).toBe('no market')
    const html = renderToStaticMarkup(<DialRow item={item} now={now} />)
    expect(html).not.toContain('data-model-arc')
    expect(html).toContain('data-model')
  })

  it('shows on every pre-open row of the board', () => {
    const html = renderToStaticMarkup(
      <DialRow item={boardItem(nykPreOpen(), undefined, S2_NOW)} now={S2_NOW} />,
    )
    expect(arcOf(html)).toBe(arcPath(50, 50, 42, MIN_ANGLE, priceToAngle(0.788449691204833)))
  })
})

describe('note 5: the count line and the rows round "opens in" the same way', () => {
  it('reads "14 h 44 min" on the count line and "14 h" on the first row, not "15 h"', () => {
    const item = boardItem(nykPreOpen(), undefined, S2_NOW)
    expect(rowWords(item, S2_NOW).note).toBe('opens in 14 h')
    expect(boardModel([nykPreOpen()], undefined, S2_NOW, []).firstOpen).toBe(
      'First market opens in 14 h 44 min',
    )
  })

  it('keeps the whole hours of inMinutes for every wait from 2 h up', () => {
    for (let secs = 2 * 3600; secs <= 30 * 3600; secs += 7 * 60 + 13) {
      const hours = /in (\d+) h/.exec(inMinutes(secs))?.[1]
      expect(roughIn(secs), String(secs)).toBe(`in ${hours} h`)
    }
    // Below 2 h both count the same minutes.
    expect(roughIn(42 * 60)).toBe(inMinutes(42 * 60))
    expect(roughIn(2 * 3600 - 1)).toBe('in 2 h')
  })
})

describe('note 6: a score names the team ahead', () => {
  const live = (awayScore: number, homeScore: number) =>
    game({ away: 'MIA', home: 'NYK', awayScore, homeScore, period: 1, clockSecs: 322 })

  it('leads with the team ahead, and says "Tied" level', () => {
    expect(scoreLine(live(15, 11))).toEqual(['MIA 15–11', 'Q1 5:22'])
    expect(scoreLine(live(11, 15))).toEqual(['NYK 15–11', 'Q1 5:22'])
    expect(scoreLine(live(15, 15))).toEqual(['Tied 15–15', 'Q1 5:22'])
    const final = game({
      away: 'MIN',
      home: 'OKC',
      status: 'final',
      awayScore: 113,
      homeScore: 106,
    })
    expect(scoreLine(final)).toEqual(['MIN 113–106', 'Final'])
  })

  it('puts it on the row, wrapping between its parts at 375 instead of cutting them', () => {
    const now = at('2026-11-25T02:08:00Z')
    const html = renderToStaticMarkup(
      <DialRow item={boardItem(live(15, 11), undefined, now)} now={now} />,
    )
    expect(text(html)).toContain('MIA @ NYKMIA 15–11 · Q1 5:22')
    expect(html).toMatch(
      /<span class="block font-mono[^"]*"><span class="whitespace-nowrap">MIA 15–11<\/span> · <span class="whitespace-nowrap">Q1 5:22<\/span><\/span>/,
    )
  })

  it('keeps the ET tip-off on a scheduled row', () => {
    const html = renderToStaticMarkup(
      <DialRow item={boardItem(nykPreOpen(), undefined, S2_NOW)} now={S2_NOW} />,
    )
    expect(text(html)).toContain('MIA @ NYK7:00 PM ET')
  })

  it('puts the final score on a final row, the winner first, not the tip-off', () => {
    const now = at('2026-11-25T06:30:00Z')
    const final = game({
      away: 'MIN',
      home: 'OKC',
      status: 'final',
      awayScore: 113,
      homeScore: 106,
      period: 4,
      clockSecs: 0,
      markets: [market({ status: 'finalized', outcome: 'no', initialPriceBps: 7_181 })],
    })
    const item = boardItem(final, undefined, now)
    expect(item.state).toBe('resolved')
    const t = text(renderToStaticMarkup(<DialRow item={item} now={now} />))
    expect(t).toContain('MIN @ OKCMIN 113–106 · Final')
    expect(t).toContain('MIN won')
    expect(t).not.toContain(' PM ET')
  })
})

describe('note 7: the eyebrow a stranger reads first says no "on the dial"', () => {
  const night = { date: '2026-11-25', upsets: 2 }

  it('reads "Last night", "Tonight" or "Last game night" with the date', () => {
    expect(lastNightHeader(night, at('2026-11-26T11:00:00Z'))).toBe(
      'Last night · Wed, Nov 25 · 2 upsets',
    )
    expect(lastNightHeader(night, at('2026-11-26T10:59:00Z'))).toBe(
      'Tonight · Wed, Nov 25 · 2 upsets',
    )
    expect(lastNightHeader(night, S2_NOW)).toBe('Last game night · Wed, Nov 25 · 2 upsets')
    expect(lastNightHeader({ ...night, upsets: 0 }, S2_NOW)).toBe(
      'Last game night · Wed, Nov 25 · no upsets',
    )
  })

  it('says no "on the dial" at any hour of a week, nor on the cards', () => {
    for (let t = at('2026-11-25T12:00:00Z'); t < at('2026-12-02T12:00:00Z'); t += 3_600) {
      expect(lastNightHeader(night, t), String(t)).not.toContain('on the dial')
    }
    const full = renderToStaticMarkup(
      <StoryCard story={{ night: REAL, game: MIN_OKC }} now={S2_NOW} />,
    )
    expect(full).not.toContain('on the dial')
  })
})

describe('note 8: the desktop readout says the 7% was the low point, not the result', () => {
  it('labels the low and whose number it is', () => {
    expect(storyLines(MIN_OKC, S2_NOW).readout).toEqual([
      'Low point · Q3 5:41 · 63–74',
      'MIN to win 7%',
      'Horagon model',
    ])
    expect(storyLines(MOVED, S2_NOW).readout?.[0]).toMatch(/^Low point · /)
    expect(storyLines(MOVED, S2_NOW).readout?.[2]).toBe('price')
  })

  it('puts "Low point" above the big number on the card', () => {
    const html = renderToStaticMarkup(
      <StoryCard story={{ night: REAL, game: MIN_OKC }} now={S2_NOW} />,
    )
    const readout = /<div [^>]*data-readout[\s\S]*?<\/div><\/div>/.exec(html)?.[0] ?? ''
    const t = text(readout)
    expect(t.indexOf('Low point')).toBeGreaterThan(-1)
    expect(t.indexOf('Low point')).toBeLessThan(t.indexOf('MIN to win 7%'))
  })
})

describe('note 9: the wallet button reads as no sign-up', () => {
  it('offers a play wallet, not a set-up step', () => {
    expect(SET_UP_WALLET).toBe('Get a play wallet')
    expect(SET_UP_WALLET).not.toMatch(/set up|sign/i)
  })

  it('is the label of the header button and the /me button', () => {
    for (const f of ['components/wallet-button.tsx', 'components/me-view.tsx']) {
      const src = read(f)
      expect(src, f).toContain('SET_UP_WALLET')
      expect(src, f).not.toContain("'Set up wallet'")
    }
  })
})
