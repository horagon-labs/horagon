// A3 (culture plan, rides with R7): the dated board label, the rest face on a night with no
// games, the calendar link and "All stopped".
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Game } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BoardView, type BoardViewProps } from '../components/chrono/board-view'
import { NightDial, RestFace } from '../components/chrono/night-dial'
import { boardLabel, boardModel, calendarLink, restLine, stoppedLine } from '../lib/chrono/board'
import { at, evening, game, NOW } from '../lib/chrono/fixtures'
import { etClockAngle, polar } from '../lib/chrono/geometry'
import { type BoardClient, loadBoard } from '../lib/server/initial'

const WEB = join(import.meta.dirname, '..')
const noop = () => {}
const OK = { stale: false, error: undefined }

// Thu, Nov 26, 4:00 AM ET: still the night of Wed, Nov 25 (06:00 ET rollover).
const REST_NOW = at('2026-11-26T09:00:00Z')
// Fri, Nov 27, 7:00 PM ET, 39 h later.
const FRI7 = at('2026-11-28T00:00:00Z')
// Sat, Nov 28, 3:30 PM ET.
const SAT330 = at('2026-11-28T20:30:00Z')

const scheduled = (iso: string, over: Partial<Game> = {}) =>
  game({ status: 'scheduled', scheduledTipoff: iso, markets: [], ...over })
const finals = (): Game[] => evening().map((g) => ({ ...g, status: 'final' as const }))

const board = (over: Partial<BoardViewProps> = {}) =>
  renderToStaticMarkup(
    <BoardView
      games={evening()}
      portfolio={undefined}
      now={NOW}
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

describe('the dated board label (string 2)', () => {
  it('names the ET night, which rolls over at 06:00 ET', () => {
    expect(boardLabel(NOW)).toBe('Tonight · Tue Nov 24')
    expect(boardLabel(at('2026-11-25T10:59:00Z'))).toBe('Tonight · Tue Nov 24')
    expect(boardLabel(at('2026-11-25T11:00:00Z'))).toBe('Tonight · Wed Nov 25')
  })

  it('heads the board, uppercased by the style only', () => {
    const html = board()
    expect(html).toMatch(/<h2 class="[^"]*uppercase[^"]*">Tonight · Tue Nov 24<\/h2>/)
  })
})

describe('the rest line (string 3) and the calendar link (string 4)', () => {
  it('says when the next tip-off is, in ET, and in how many hours', () => {
    expect(restLine({ tip: FRI7, count: 4 }, REST_NOW)).toBe(
      'The dial rests tonight. Next tip-off Fri, Nov 27 · 7:00 PM ET · in 39 h',
    )
    expect(restLine(null, REST_NOW)).toBe('The dial rests tonight.')
    expect(restLine({ tip: REST_NOW - 60, count: 1 }, REST_NOW)).toBe('The dial rests tonight.')
  })

  it("links the next game day's calendar file by its ET date", () => {
    expect(calendarLink({ tip: FRI7, count: 4 })).toEqual({
      href: '/calendar/2026-11-27',
      label: "Add Friday's games to your calendar",
    })
  })

  it('rests only on a board with no game tonight', () => {
    const rest = boardModel([], undefined, REST_NOW, [], { tip: FRI7, count: 4 })
    expect(rest.rest).toBe(
      'The dial rests tonight. Next tip-off Fri, Nov 27 · 7:00 PM ET · in 39 h',
    )
    expect(rest.calendar?.href).toBe('/calendar/2026-11-27')
    expect(boardModel([], undefined, REST_NOW, []).calendar).toBeNull()
    const night = boardModel(evening(), undefined, NOW, [])
    expect(night.rest).toBeNull()
    expect(night.calendar).toBeNull()
    expect(boardModel(undefined, undefined, NOW, []).rest).toBeNull()
  })
})

describe('a night with no game, the next slate under 24 h away (R7 review adv-1, finding 1)', () => {
  // Thu, Nov 26, 8:00 PM ET: the night of Thu, Nov 26 has no game; Friday's tip at 7:00 PM ET is
  // 23 h away, so the 24 h list already holds it.
  const THU8 = at('2026-11-27T01:00:00Z')
  const fri = () => [
    scheduled('2026-11-28T00:00:00.000Z', { id: 'nba-fri-1' }),
    scheduled('2026-11-28T00:30:00.000Z', { id: 'nba-fri-2', home: 'TOR', away: 'BOS' }),
  ]

  it('rests the dial by the night, not by the 24 h window', () => {
    const m = boardModel(fri(), undefined, THU8, [])
    expect(m.rest).toBe('The dial rests tonight. Next tip-off Fri, Nov 27 · 7:00 PM ET · in 23 h')
    expect(m.calendar?.href).toBe('/calendar/2026-11-27')
    expect(m.stopped).toBeNull()
    // The resting dial draws no arc: the next night's games are not tonight's.
    expect(m.dial).toEqual([])
  })

  it("lists the next night's games under their own date, never under tonight's", () => {
    const m = boardModel(fri(), undefined, THU8, [])
    expect(m.items.map((i) => i.id).sort()).toEqual(['nba-fri-1', 'nba-fri-2'])
    expect(m.label).toBe('Next · Fri Nov 27')
    const html = board({ games: fri(), now: THU8 })
    expect(html).not.toContain('Tonight · Thu Nov 26')
    expect(html).toMatch(/<h2 class="[^"]*uppercase[^"]*">Next · Fri Nov 27<\/h2>/)
    expect(html).toContain('data-rest')
    expect(html).toContain(
      'The dial rests tonight. Next tip-off Fri, Nov 27 · 7:00 PM ET · in 23 h',
    )
    expect(html).not.toMatch(/data-id="nba-fri-1"/)
  })

  it('rests the same way in the morning, with the slate past 24 h', () => {
    const m = boardModel(fri(), undefined, at('2026-11-26T15:00:00Z'), [])
    expect(m.items).toHaveLength(0)
    expect(m.label).toBe('Tonight · Thu Nov 26')
    expect(m.rest).toBe('The dial rests tonight. Next tip-off Fri, Nov 27 · 7:00 PM ET · in 33 h')
  })

  it('after a night whose games stopped, heads the next games by their date', () => {
    // Wed, Nov 25, 3:30 AM ET: the night of Tue, Nov 24 is over and out of the 4 h window;
    // Wednesday's 7:00 PM ET game is on the list.
    const late = at('2026-11-25T08:30:00Z')
    const wed = scheduled('2026-11-26T00:00:00.000Z', { id: 'nba-wed' })
    const m = boardModel([...finals(), wed], undefined, late, [])
    expect(m.items.map((i) => i.id)).toEqual(['nba-wed'])
    expect(m.label).toBe('Next · Wed Nov 25')
    expect(m.rest).toBeNull()
    expect(m.stopped).toBe('All stopped. Next tip-off Wed 7:00 PM ET.')
  })

  it("heads the next night's games apart when the list also holds the night's own", () => {
    // Fri, Nov 27, 11:00 PM ET: Friday's game is final, Saturday's 7:30 PM ET game is listed.
    const fri11 = at('2026-11-28T04:00:00Z')
    const f1 = scheduled('2026-11-28T00:30:00.000Z', {
      id: 'f1',
      status: 'final',
      homeScore: 100,
      awayScore: 90,
    })
    const t1 = scheduled('2026-11-29T00:30:00.000Z', { id: 't1', home: 'TOR', away: 'BOS' })
    const m = boardModel([f1, t1], undefined, fri11, [])
    expect(m.label).toBe('Tonight · Fri Nov 27')
    expect(m.list.map((i) => i.id)).toEqual(['f1'])
    expect(m.later).toEqual([
      { label: 'Next · Sat Nov 28', items: [m.items.find((i) => i.id === 't1')] },
    ])
    const html = board({ games: [f1, t1], now: fri11 })
    const heading = html.indexOf('>Next · Sat Nov 28<')
    expect(heading).toBeGreaterThan(-1)
    expect(html.indexOf('/game/f1')).toBeLessThan(heading)
    expect(html.indexOf('/game/t1')).toBeGreaterThan(heading)
    // A list of the night's games only has no second heading.
    expect(boardModel(evening(), undefined, NOW, []).later).toEqual([])
  })

  it("keeps tonight's date while a game of the night is listed", () => {
    expect(boardModel(evening(), undefined, NOW, []).label).toBe('Tonight · Tue Nov 24')
    expect(boardModel(evening(), undefined, NOW, []).dial).toHaveLength(
      boardModel(evening(), undefined, NOW, []).items.length,
    )
  })
})

describe('All stopped (string 21)', () => {
  it('says the next tip-off once every game of the night stopped', () => {
    expect(stoppedLine(SAT330, NOW)).toBe('All stopped. Next tip-off Sat 3:30 PM ET.')
    expect(stoppedLine(null, NOW)).toBe('All stopped.')
    const games = [...finals(), scheduled('2026-11-28T20:30:00.000Z', { id: 'nba-sat' })]
    expect(boardModel(games, undefined, NOW, []).stopped).toBe(
      'All stopped. Next tip-off Sat 3:30 PM ET.',
    )
    // The next tip-off can come from the server's look-ahead.
    expect(boardModel(finals(), undefined, NOW, [], { tip: SAT330, count: 1 }).stopped).toBe(
      'All stopped. Next tip-off Sat 3:30 PM ET.',
    )
    // A follow filter does not hide that the night is over.
    expect(boardModel(finals(), undefined, NOW, ['TOR']).stopped).toBe('All stopped.')
  })

  it('never rests a night that had games, once they left the 4 h window', () => {
    // Wed, Nov 25, 3:30 AM ET: still the night of Tue, Nov 24, whose games all tipped off over
    // 4 h ago, so none is on the board.
    const late = at('2026-11-25T08:30:00Z')
    const m = boardModel(finals(), undefined, late, [], { tip: SAT330, count: 1 })
    expect(m.items).toHaveLength(0)
    expect(m.rest).toBeNull()
    expect(m.calendar).toBeNull()
    expect(m.stopped).toBe('All stopped. Next tip-off Sat 3:30 PM ET.')
    const html = board({ games: finals(), now: late, upcoming: { tip: SAT330, count: 1 } })
    expect(html).not.toContain('data-rest')
    expect(html).not.toContain('The dial rests tonight.')
    // The dial says it too.
    expect(html).toMatch(/<span class="[^"]*">All stopped\. Next tip-off Sat 3:30 PM ET\.<\/span>/)
  })

  it('stays away while a game of the night still trades, and on an empty night', () => {
    expect(boardModel(evening(), undefined, NOW, []).stopped).toBeNull()
    expect(boardModel([], undefined, NOW, []).stopped).toBeNull()
  })

  it('shows on the board', () => {
    const html = board({ games: finals(), upcoming: { tip: SAT330, count: 1 } })
    expect(html).toMatch(/data-stopped[^>]*>All stopped\. Next tip-off Sat 3:30 PM ET\.</)
  })
})

describe('the rest face of the Night dial', () => {
  const rest = (over: Partial<BoardViewProps> = {}) =>
    board({ games: [], upcoming: { tip: FRI7, count: 4 }, now: REST_NOW, ...over })

  it('draws 12 · 3 · 6 · 9 at r 80 with ET under the 6, and says string 3 in the middle', () => {
    const html = rest()
    expect(html).toContain('data-rest')
    for (const n of ['12', '3', '6', '9']) {
      expect(html).toMatch(
        new RegExp(`<text [^>]*class="fill-ink font-mono text-\\[9px\\]"[^>]*>${n}</text>`),
      )
    }
    const twelve = polar(100, 100, 80, 0)
    expect(html).toContain(`x="${twelve.x}" y="${twelve.y}"`)
    expect(html).toMatch(/<text [^>]*>ET<\/text>/)
    expect(html).toContain(
      'The dial rests tonight. Next tip-off Fri, Nov 27 · 7:00 PM ET · in 39 h',
    )
    // The list keeps its words, and adds the calendar link.
    expect(html).toContain('Next games: Fri, Nov 27 · 4 games from 7:00 PM ET')
    expect(html).toContain(
      '<p role="status" class="sr-only">No NBA games in the next 24 hours.</p>',
    )
    expect(html).toMatch(
      /<a [^>]*href="\/calendar\/2026-11-27"[^>]*>Add Friday&#x27;s games to your calendar<\/a>/,
    )
  })

  it('drops the readout ring at rest, so the wider words never run through it (light)', () => {
    const rest = renderToStaticMarkup(
      <NightDial items={[]} now={REST_NOW} selectedId={null} onSelect={noop} emptyText="x" rest />,
    )
    expect(rest).not.toContain('data-hub')
    const empty = renderToStaticMarkup(
      <NightDial items={[]} now={REST_NOW} selectedId={null} onSelect={noop} emptyText="x" />,
    )
    expect(empty).toContain('data-hub')
  })

  it('starts the now hand past the wider words at rest, so it never strikes through them', () => {
    // At rest the words may run 56% of the face wide: 56 units each side of the centre. Every
    // 10 minutes of the 12-hour face, 3:00 and 9:00 ET included, the hand starts past them.
    const start = (html: string) => {
      const line = html.match(/<line [^>]*data-now[^>]*>/)?.[0] ?? ''
      const num = (a: string) => Number(line.match(new RegExp(`${a}="([^"]+)"`))?.[1])
      return Math.hypot(num('x1') - 100, num('y1') - 100)
    }
    const threeEt = at('2026-11-26T08:00:00Z')
    for (let m = 0; m < 12 * 60; m += 10) {
      const now = threeEt + m * 60
      const html = renderToStaticMarkup(
        <NightDial items={[]} now={now} selectedId={null} onSelect={noop} emptyText="x" rest />,
      )
      const half = Number(html.match(/max-w-\[(\d+)%\]/)?.[1])
      expect(half).toBe(56)
      expect(start(html)).toBeGreaterThan(half + 4)
    }
    // With arcs on the face, the hand still starts at the r 33 readout ring.
    const empty = renderToStaticMarkup(
      <NightDial items={[]} now={threeEt} selectedId={null} onSelect={noop} emptyText="x" />,
    )
    expect(start(empty)).toBeCloseTo(33, 2)
  })

  it('puts an ink pip on the now hand and a seconds pip at r 97, stepping 6° a second', () => {
    const now = REST_NOW + 15
    const html = renderToStaticMarkup(
      <NightDial items={[]} now={now} selectedId={null} onSelect={noop} emptyText="x" rest />,
    )
    const tip = polar(100, 100, 92, etClockAngle(now))
    expect(html).toMatch(
      new RegExp(`<circle cx="${tip.x}" cy="${tip.y}" r="2" class="fill-ink" data-now-pip`),
    )
    const sec = polar(100, 100, 97, 90)
    expect(html).toMatch(
      new RegExp(`<circle cx="${sec.x}" cy="${sec.y}" r="1.8" class="fill-ink" data-seconds`),
    )
  })

  it('hides the seconds pip under reduced motion, and has no tween', () => {
    const still = renderToStaticMarkup(
      <svg aria-hidden="true">
        <RestFace now={REST_NOW} reduced />
      </svg>,
    )
    expect(still).toContain('data-rest')
    expect(still).not.toContain('data-seconds')
    const src = readFileSync(join(WEB, 'components', 'chrono', 'night-dial.tsx'), 'utf8')
    expect(src).toContain('useMotionReduced()')
    expect(src).not.toMatch(/transition/)
  })

  it('is absent on a night with games, and while the games load', () => {
    expect(board()).not.toContain('data-rest')
    expect(board({ games: undefined })).not.toContain('data-rest')
    expect(board()).not.toContain('/calendar/')
  })
})

describe('the server look-ahead (string 21)', () => {
  it('looks ahead once every game of the night stopped', async () => {
    const fri = scheduled('2026-11-28T00:00:00.000Z', { id: 'nba-fri' })
    const list = vi.fn(async (q?: { date?: string }) =>
      q?.date === undefined ? finals() : q.date === '2026-11-27' ? [fri] : [],
    )
    const c = { games: { list, get: vi.fn() } } as unknown as BoardClient
    const b = await loadBoard(c, NOW)
    expect(b.upcoming).toEqual({ tip: FRI7, count: 1 })
  })
})
