// First screen, slice 1 "Honest board" (first-screen spec §3 S2/S3, §5 C1/C3/C4, C9, C14,
// C16-C23, C25, §7 W3/W4/W5/W7): every row carries a real number, the board never says it rests
// beside a listed slate, a number is Live blue only while its market trades, and the hero no
// longer claims a price move.
import type { Game } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BoardView, type BoardViewProps } from '../components/chrono/board-view'
import { DialRow } from '../components/chrono/dial-row'
import { HERO_LINE, HERO_STEPS, HERO_SUB, Hero } from '../components/chrono/hero'
import { MiniDial } from '../components/chrono/mini-dial'
import { YourHour } from '../components/chrono/your-hour'
import { LastNightStrip } from '../components/last-night'
import {
  boardItem,
  boardLabel,
  boardModel,
  nextLabel,
  restLine,
  rowWords,
  sinceOpen,
} from '../lib/chrono/board'
import { at, game, market, portfolio } from '../lib/chrono/fixtures'
import { inMinutes, roughIn } from '../lib/chrono/time'
import {
  type LastNight,
  type LastNightRow,
  lastNightHeader,
  lastNightRowText,
  nightRows,
} from '../lib/server/last-night'

const noop = () => {}
const OK = { stale: false, error: undefined }

// Fri, Nov 27, 3:16 AM ET: the audited judge visit (spec §3 S2).
const S2_NOW = at('2026-11-27T08:16:00Z')

/** Friday's real slate (production API, 2026-11-27): tip-off and the model's home chance. */
const FRIDAY: Array<[string, string, string, string, number]> = [
  ['nba-401909326', 'MIA', 'NYK', '2026-11-28T00:00:00.000Z', 0.788449691204833],
  ['nba-401909327', 'MIL', 'DET', '2026-11-28T00:30:00.000Z', 0.916729335085093],
  ['nba-401909328', 'PHI', 'IND', '2026-11-28T00:30:00.000Z', 0.288877668767926],
  ['nba-401909329', 'BKN', 'TOR', '2026-11-28T00:30:00.000Z', 0.786859361024766],
  ['nba-401909330', 'ATL', 'BOS', '2026-11-28T01:00:00.000Z', 0.735993175511286],
  ['nba-401909331', 'MEM', 'MIN', '2026-11-28T01:30:00.000Z', 0.799720662934529],
  ['nba-401909332', 'DAL', 'PHX', '2026-11-28T02:00:00.000Z', 0.701587568921789],
  ['nba-401909333', 'LAL', 'SAS', '2026-11-28T02:30:00.000Z', 0.688024047652624],
  ['nba-401909334', 'DEN', 'UTA', '2026-11-28T02:30:00.000Z', 0.309780700787161],
  ['nba-401909335', 'NOP', 'LAC', '2026-11-28T02:30:00.000Z', 0.743909590382743],
  ['nba-401909336', 'GSW', 'POR', '2026-11-28T02:30:00.000Z', 0.769119250341338],
]

const scheduled = (id: string, away: string, home: string, tip: string, modelProb: number): Game =>
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
    modelProb,
    markets: [],
  })

const friday = (): Game[] => FRIDAY.map(([id, a, h, tip, p]) => scheduled(id, a, h, tip, p))

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
      {...over}
    />,
  )

/** The text of every row link, tags stripped. */
const rowTexts = (html: string) =>
  [...html.matchAll(/<a [^>]*href="\/game\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
    (m[1] ?? '').replace(/<[^>]+>/g, ''),
  )

describe('the shared relative times (W4: inMinutes moves to time.ts)', () => {
  it('reads minutes and hours, as R8 wrote them', () => {
    expect(inMinutes(47 * 60)).toBe('in 47 min')
    expect(inMinutes(14 * 3600 + 44 * 60)).toBe('in 14 h 44 min')
    expect(inMinutes(3 * 3600)).toBe('in 3 h')
    expect(inMinutes(5)).toBe('in 1 min')
  })

  it('rounds to whole hours from 2 h up, and counts minutes below (C19)', () => {
    expect(roughIn(14 * 3600 + 44 * 60)).toBe('in 15 h')
    expect(roughIn(2 * 3600)).toBe('in 2 h')
    expect(roughIn(2 * 3600 - 60)).toBe('in 119 min')
    expect(roughIn(42 * 60)).toBe('in 42 min')
    expect(roughIn(10)).toBe('in 1 min')
  })
})

describe('a pre-open row says the model number and when it opens (C19)', () => {
  const nyk = boardItem(friday()[0] as Game, undefined, S2_NOW)

  it('names whose chance, the model %, and the opening time in whole hours', () => {
    expect(rowWords(nyk, S2_NOW)).toEqual({
      subject: 'NYK to win',
      value: '79%',
      model: true,
      note: 'opens in 15 h',
      wide: '',
    })
    // 42 min before the open.
    const soon = at('2026-11-27T22:18:00Z')
    expect(rowWords(boardItem(friday()[0] as Game, undefined, soon), soon).note).toBe(
      'opens in 42 min',
    )
  })

  it('draws no dash, no "tip-off" prefix and no Live blue', () => {
    const html = renderToStaticMarkup(<DialRow item={nyk} now={S2_NOW} />)
    const text = html.replace(/<[^>]+>/g, '')
    expect(text).toContain('MIA @ NYK7:00 PM ET')
    expect(text).toContain('NYK to win79% modelopens in 15 h')
    expect(text).not.toContain('—')
    expect(text).not.toContain('tip-off')
    expect(html).not.toContain('text-live')
    // The number in ink-muted, " model" in 12 ink-muted.
    expect(html).toMatch(/<span class="[^"]*font-mono text-19[^"]*text-ink-muted[^"]*">79%/)
    expect(html).toContain('<span class="font-sans text-12 text-ink-muted"> model</span>')
  })

  it('puts an ink ▲ on the MiniDial rim at the model while no market exists', () => {
    const html = renderToStaticMarkup(<DialRow item={nyk} now={S2_NOW} />)
    expect(html).toMatch(/<path [^>]*class="fill-ink"[^>]*data-model/)
    const priced = renderToStaticMarkup(
      <MiniDial price={0.6} model={0.79} timeLeft={0.5} state="live" />,
    )
    expect(priced).not.toContain('data-model')
    const none = renderToStaticMarkup(<MiniDial price={null} timeLeft={1} state="pre" />)
    expect(none).not.toContain('data-model')
  })
})

describe('a trading row says the move since open (C20)', () => {
  it('signs the move in points, with U+2212 for a fall', () => {
    expect(sinceOpen(0.81, 7_900)).toBe('+2 since open')
    expect(sinceOpen(0.6, 7_900)).toBe('−19 since open')
    expect(sinceOpen(0.79, 7_900)).toBe('opening price')
    expect(sinceOpen(0.794, 7_900)).toBe('+0.4 since open')
    expect(sinceOpen(0.7904, 7_900)).toBe('opening price')
    expect(sinceOpen(0.78996, 7_900)).toBe('opening price')
  })

  it('reads the move, and the close from sm up', () => {
    const now = at('2026-11-25T02:08:00Z')
    const live = boardItem(game({ markets: [market({ initialPriceBps: 7_500 })] }), undefined, now)
    expect(rowWords(live, now)).toEqual({
      subject: 'CLE to win',
      value: '77%',
      model: false,
      note: '+2 since open',
      wide: ' · closes by 10:10 PM ET',
    })
    const html = renderToStaticMarkup(<DialRow item={live} now={now} />)
    expect(html).toContain('+2 since open<span class="hidden sm:inline"> · closes by 10:10 PM ET')
    expect(html).not.toContain('latest')
  })

  it('paints the number Live blue only while its market trades', () => {
    const now = at('2026-11-25T02:08:00Z')
    const live = renderToStaticMarkup(
      <DialRow item={boardItem(game(), undefined, now)} now={now} />,
    )
    expect(live).toMatch(/<span class="[^"]*font-mono text-19[^"]*text-live[^"]*">77%/)
    const halted = renderToStaticMarkup(
      <DialRow
        item={boardItem(game({ markets: [market({ status: 'halted' })] }), undefined, now)}
        now={now}
      />,
    )
    expect(halted).not.toContain('text-live')
  })

  it('marks the first trading row as the "Pick a game" target', () => {
    const now = at('2026-11-25T02:08:00Z')
    const first = renderToStaticMarkup(
      <DialRow item={boardItem(game(), undefined, now)} now={now} first />,
    )
    expect(first).toContain('id="first-open"')
  })
})

describe('a resolved row names the winner and its opening (C21)', () => {
  const now = at('2026-11-26T12:00:00Z')
  const min = (price: number) =>
    boardItem(
      game({
        id: 'nba-401909320',
        home: 'OKC',
        away: 'MIN',
        status: 'final',
        homeScore: 106,
        awayScore: 113,
        markets: [
          market({ status: 'finalized', outcome: 'no', initialPriceBps: 7_181, price, endTs: 1 }),
        ],
      }),
      undefined,
      now,
    )

  it('prints "closed" only when the price moved', () => {
    expect(rowWords(min(0.718099960839607), now)).toEqual({
      subject: 'MIN won',
      value: '',
      model: false,
      note: 'opened 28%',
      wide: '',
    })
    expect(rowWords(min(0.19), now).note).toBe('opened 28% · closed 81%')
  })
})

describe('the board at 08:16Z with Friday listed (spec §3 S2)', () => {
  const m = boardModel(friday(), undefined, S2_NOW, [])

  it('never rests beside a listed slate: the dial keeps the pre-open arcs', () => {
    expect(m.rest).toBeNull()
    expect(m.dial).toHaveLength(11)
    expect(m.label).toBe('Fri Nov 27 · 11 games')
    expect(m.openNow).toBe(0)
    expect(m.firstOpen).toBe('First market opens in 14 h 44 min')
    expect(m.note).toBe(true)
    expect(m.calendar).toEqual({
      href: '/calendar/2026-11-27',
      label: "Add Friday's games to your calendar",
    })
  })

  it('shows a number on every row, and no rest line, dash or "tip-off"', () => {
    const html = board()
    expect(html).not.toContain('rests')
    expect(html).not.toContain('data-rest')
    const rows = rowTexts(html)
    expect(rows).toHaveLength(11)
    for (const r of rows) {
      expect(r).toMatch(/to win\d+% modelopens in \d+ h/)
      expect(r).not.toContain('—')
      expect(r).not.toContain('tip-off')
    }
    expect(html.match(/\d%/g)?.length ?? 0).toBeGreaterThanOrEqual(11)
  })

  it('heads the list, counts down to the first open, and says how a market opens', () => {
    const html = board()
    expect(html).toMatch(/<h2 class="[^"]*uppercase[^"]*">Fri Nov 27 · 11 games<\/h2>/)
    expect(html).toContain('>First market opens in 14 h 44 min<')
    expect(html).toContain(
      '>Each market opens 60 min before tip-off at the model&#x27;s chance at that time.<',
    )
    // The count line comes before the note, and both before the first row.
    const first = html.indexOf('First market opens')
    const note = html.indexOf('Each market opens')
    expect(first).toBeLessThan(note)
    expect(note).toBeLessThan(html.indexOf('href="/game/'))
  })

  it('moves the calendar link under the list, as a bordered button', () => {
    const html = board()
    const cal = html.indexOf('href="/calendar/2026-11-27"')
    expect(cal).toBeGreaterThan(html.lastIndexOf('href="/game/'))
    expect(html).toMatch(
      /<a href="\/calendar\/2026-11-27" class="[^"]*min-h-11[^"]*border[^"]*"[^>]*>Add Friday&#x27;s games to your calendar<\/a>/,
    )
  })

  it('has Live blue nowhere while no market is open', () => {
    expect(board()).not.toContain('text-live')
  })
})

describe('the board with markets open (spec §3 S3/S4, C17)', () => {
  // Thu, Nov 27, 6:30 PM ET: NYK opened at 79% and now reads 81%; the rest wait.
  const now = at('2026-11-27T23:30:00Z')
  const open = () =>
    friday().map((g, i) =>
      i === 0
        ? {
            ...g,
            markets: [
              market({
                pubkey: 'MktNyk1111111111111111111111111111111111111',
                initialPriceBps: 7_884,
                price: 0.81,
                priceTs: now - 5,
                endTs: at('2026-11-28T05:32:00Z'),
              }),
            ],
          }
        : g,
    )

  it('counts the open markets, links to the first, and keeps the note before any game is live', () => {
    const m = boardModel(open(), undefined, now, [])
    expect(m.openNow).toBe(1)
    expect(m.firstOpen).toBeNull()
    expect(m.note).toBe(true)
    expect(m.calendar).toBeNull()
    const html = board({ games: open(), now })
    expect(html).toMatch(
      /<p [^>]*data-count[^>]*><span aria-hidden="true" class="text-live">●<\/span> 1 market open now · <a href="#first-open"[^>]*>Pick a game<\/a><\/p>/,
    )
    expect(html).toMatch(/<a [^>]*id="first-open"[^>]*href="\/game\/nba-401909326"/)
    expect(html.match(/id="first-open"/g)).toHaveLength(1)
    // The open row is the only Live blue number; the pre-open rows stay ink-muted.
    expect(html.match(/text-19[^"]*text-live/g)).toHaveLength(1)
    expect(html).toContain('+2 since open')
  })

  it('says "markets" for more than one, and drops the note once a game is live', () => {
    const now2 = at('2026-11-25T02:08:00Z')
    const m = boardModel(
      [game(), game({ id: 'nba-2', home: 'TOR', away: 'BOS' })],
      undefined,
      now2,
      [],
    )
    expect(m.openNow).toBe(2)
    expect(m.note).toBe(false)
    const html = board({
      games: [game(), game({ id: 'nba-2', home: 'TOR', away: 'BOS' })],
      now: now2,
    })
    expect(html).toContain(' 2 markets open now · ')
  })
})

describe('the board heading carries the date and the count (C16)', () => {
  it('reads "Tonight · Fri Nov 27 · 11 games" for the night, the date alone for a later one', () => {
    const noon = at('2026-11-27T17:00:00Z')
    expect(boardLabel(noon, 11)).toBe('Tonight · Fri Nov 27 · 11 games')
    expect(boardLabel(noon, 1)).toBe('Tonight · Fri Nov 27 · 1 game')
    expect(boardLabel(noon)).toBe('Tonight · Fri Nov 27')
    expect(nextLabel(at('2026-11-28T00:00:00Z'), 11)).toBe('Fri Nov 27 · 11 games')
  })
})

describe('the rest line is date-true (C22)', () => {
  it('names the day the dial rests until, the games and the first tip-off', () => {
    const now = at('2026-11-26T09:00:00Z')
    const fri7 = at('2026-11-28T00:00:00Z')
    expect(restLine({ tip: fri7, count: 4 }, now)).toBe(
      'The dial rests until Fri, Nov 27. 4 games, first tip-off in 39 h.',
    )
    expect(restLine({ tip: fri7, count: 1 }, now)).toBe(
      'The dial rests until Fri, Nov 27. 1 game, tip-off in 39 h.',
    )
    expect(restLine(null, now)).toBe('No NBA games in the next 24 hours.')
  })

  it('rests only with an empty 24 h list', () => {
    const now = at('2026-11-26T09:00:00Z')
    const m = boardModel([], undefined, now, [], { tip: at('2026-11-28T00:00:00Z'), count: 4 })
    expect(m.rest).toBe('The dial rests until Fri, Nov 27. 4 games, first tip-off in 39 h.')
    expect(m.calendar?.href).toBe('/calendar/2026-11-27')
    expect(m.firstOpen).toBeNull()
  })
})

describe('the header chip hides at 0 open positions (C25)', () => {
  it('renders nothing for a wallet with none, and the chip with one', () => {
    expect(renderToStaticMarkup(<YourHour portfolio={portfolio([])} onOpen={noop} />)).toBe('')
  })
})

describe('the hero claims no price move (C1, C3, C4)', () => {
  it('says the final words', () => {
    expect(HERO_LINE).toBe('Call the winner while the NBA game is on. Open until the final buzzer.')
    expect(HERO_SUB).toBe('Play money on Solana devnet. Free, no sign-up.')
    expect(HERO_STEPS).toEqual([
      'Pick a game.',
      'Back a team: each share pays 1 mUSDC if it wins.',
      'Watch the price move with the game; claim after the result.',
    ])
  })

  it('folds the three steps under "How it works"', () => {
    const html = renderToStaticMarkup(<Hero />)
    expect(html).not.toContain('Prices move')
    expect(html).toMatch(/<details[^>]*data-how[^>]*><summary[^>]*>.*?How it works<\/summary>/)
    expect(html.match(/<li /g)).toHaveLength(3)
    expect(html.indexOf('How it works')).toBeLessThan(html.indexOf('Pick a game.'))
  })
})

describe('last night, kept honest (C9, C14)', () => {
  const night = (over: Partial<LastNight> = {}): LastNight => ({
    date: '2026-11-25',
    rows: [],
    upsets: 2,
    ...over,
  })

  it('says "Last night" only for the ET calendar day before today', () => {
    // Thu, Nov 26, 6:00 AM ET and later that day (a gap day): Wednesday was last night.
    expect(lastNightHeader(night(), at('2026-11-26T11:00:00Z'))).toBe(
      'Last night on the dial · Wed, Nov 25 · 2 upsets',
    )
    expect(lastNightHeader(night(), at('2026-11-27T04:59:00Z'))).toBe(
      'Last night on the dial · Wed, Nov 25 · 2 upsets',
    )
    // Fri, Nov 27, 3:16 AM ET: Wednesday is two calendar days back.
    expect(lastNightHeader(night(), S2_NOW)).toBe('Wed, Nov 25 on the dial · 2 upsets')
    expect(lastNightHeader(night({ upsets: 1 }), S2_NOW)).toBe('Wed, Nov 25 on the dial · 1 upset')
    expect(lastNightHeader(night({ upsets: 0 }), S2_NOW)).toBe(
      'Wed, Nov 25 on the dial · no upsets',
    )
  })

  it('says "Tonight" while the night is still the ET night (before the 06:00 ET rollover)', () => {
    expect(lastNightHeader(night(), at('2026-11-26T10:59:00Z'))).toBe(
      'Tonight on the dial · Wed, Nov 25 · 2 upsets',
    )
  })

  const row = (over: Partial<LastNightRow> = {}): LastNightRow => ({
    id: 'nba-401909318',
    winner: 'CHI',
    loser: 'CHA',
    winScore: 107,
    loseScore: 105,
    openedBps: 2_556,
    closed: 0.255600063695878,
    moved: false,
    upset: true,
    overtime: false,
    tipoff: '2026-11-26T00:00:00.000Z',
    ...over,
  })

  it('prints "closed" only when the price moved', () => {
    expect(lastNightRowText(row())).toBe('CHI 107–105 CHA · opened 26%')
    expect(lastNightRowText(row({ closed: 0.81, moved: true }))).toBe(
      'CHI 107–105 CHA · opened 26% · closed 81%',
    )
  })

  it('reads moved from the indexed price against the opening (real ET 11-25: none moved)', () => {
    const chi = game({
      id: 'nba-401909318',
      home: 'CHA',
      away: 'CHI',
      status: 'final',
      homeScore: 105,
      awayScore: 107,
      markets: [
        market({
          status: 'recycled',
          outcome: 'no',
          initialPriceBps: 7_444,
          price: 0.744399936304122,
        }),
      ],
    })
    expect(nightRows([chi]).rows[0]?.moved).toBe(false)
    const moved = {
      ...chi,
      markets: [market({ status: 'recycled', initialPriceBps: 7_444, price: 0.19 })],
    }
    expect(nightRows([moved]).rows[0]?.moved).toBe(true)
  })

  it('renders the dated header from the page clock', () => {
    const html = renderToStaticMarkup(
      <LastNightStrip night={night({ rows: [row()] })} now={S2_NOW} />,
    )
    expect(html).toContain('>Wed, Nov 25 on the dial · 2 upsets</h2>')
    expect(html).not.toContain('closed')
  })
})
