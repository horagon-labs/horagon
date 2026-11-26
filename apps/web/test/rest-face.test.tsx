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
        new RegExp(`<text [^>]*class="fill-brass-500 font-mono text-\\[9px\\]"[^>]*>${n}</text>`),
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

  it('puts a lume pip on the now hand and a seconds pip at r 97, stepping 6° a second', () => {
    const now = REST_NOW + 15
    const html = renderToStaticMarkup(
      <NightDial items={[]} now={now} selectedId={null} onSelect={noop} emptyText="x" rest />,
    )
    const tip = polar(100, 100, 92, etClockAngle(now))
    expect(html).toMatch(
      new RegExp(`<circle cx="${tip.x}" cy="${tip.y}" r="2" class="fill-lume-300" data-now-pip`),
    )
    const sec = polar(100, 100, 97, 90)
    expect(html).toMatch(
      new RegExp(`<circle cx="${sec.x}" cy="${sec.y}" r="1.8" class="fill-ivory-100" data-seconds`),
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
