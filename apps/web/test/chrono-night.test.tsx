import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DialRow } from '../components/chrono/dial-row'
import { NightDial } from '../components/chrono/night-dial'
import { boardItem, itemLabel, listOrder } from '../lib/chrono/board'
import { evening, game, market, NOW, portfolio, position } from '../lib/chrono/fixtures'
import { keyStep } from '../lib/chrono/keys'

const held = portfolio([position()])
const items = evening()
  .map((g) => boardItem(g, held, NOW))
  .sort(listOrder)

const night = (over: Partial<Parameters<typeof NightDial>[0]> = {}) =>
  renderToStaticMarkup(
    <NightDial
      items={items}
      now={NOW}
      selectedId={null}
      onSelect={() => {}}
      emptyText="No NBA games in the next 24 hours."
      {...over}
    />,
  )

/** The sr-only options in document order, as [id suffix, selected, text]. */
const options = (html: string) =>
  [
    ...html.matchAll(
      /id="[^"]*-(\d+)" role="option" tabindex="-1" aria-selected="(true|false)" class="sr-only">([^<]*)</g,
    ),
  ].map((m) => [Number(m[1]), m[2] === 'true', m[3] ?? ''] as const)

describe('keyStep (spec 2.6)', () => {
  it('moves a slider one step on arrows, three on PageUp/PageDown, to the ends on Home/End', () => {
    expect(keyStep('ArrowUp', 2, 8, 'slider')).toBe(3)
    expect(keyStep('ArrowRight', 2, 8, 'slider')).toBe(3)
    expect(keyStep('ArrowDown', 2, 8, 'slider')).toBe(1)
    expect(keyStep('ArrowLeft', 2, 8, 'slider')).toBe(1)
    expect(keyStep('PageUp', 2, 8, 'slider')).toBe(5)
    expect(keyStep('PageDown', 2, 8, 'slider')).toBe(0)
    expect(keyStep('Home', 5, 8, 'slider')).toBe(0)
    expect(keyStep('End', 0, 8, 'slider')).toBe(7)
  })

  it('walks a list down or right, clamps at both ends, and ignores other keys', () => {
    expect(keyStep('ArrowDown', 0, 3, 'list')).toBe(1)
    expect(keyStep('ArrowUp', 0, 3, 'list')).toBe(0)
    expect(keyStep('ArrowRight', 2, 3, 'list')).toBe(2)
    expect(keyStep('PageUp', 0, 3, 'list')).toBeNull()
    expect(keyStep('a', 0, 3, 'list')).toBeNull()
    expect(keyStep('ArrowDown', 0, 0, 'list')).toBeNull()
  })
})

describe('itemLabel (spec 2.6)', () => {
  it('reads the score, the dial sentence and your position', () => {
    expect(itemLabel(boardItem(game(), held, NOW))).toBe(
      'MEM 78, CLE 84. CLE to win, 77%, model 74%, open until the final buzzer. You hold a position',
    )
  })

  it('reads a game without a market as not open yet', () => {
    const phx = items.find((i) => i.id === 'nba-401810004')
    expect(phx && itemLabel(phx)).toBe(
      'DEN at PHX. PHX to win, no price yet, model 44%, market opens 60 min before tip-off',
    )
  })
})

describe('NightDial (spec 3.2, 4.1)', () => {
  it('hides the picture and lists every arc for screen readers, by closing time', () => {
    const html = night()
    expect(html).toContain('role="listbox"')
    expect(html).toContain('<svg viewBox="0 0 200 200" aria-hidden="true"')
    const opts = options(html)
    expect(opts.map((o) => o[0])).toEqual([0, 1, 2, 3, 4])
    expect(opts.map((o) => o[2].split('.')[0])).toEqual([
      'BOS 101, MIL 99',
      'MEM 78, CLE 84',
      'NYK 44, ATL 47',
      'DEN at PHX',
      'LAL at SAC',
    ])
    expect(html).toMatch(/aria-activedescendant="[^"]*-0"/)
  })

  it('marks the selected game in the list and puts its summary in the middle', () => {
    const html = night({ selectedId: 'nba-401810002' })
    expect(options(html).map((o) => o[1])).toEqual([false, false, true, false, false])
    expect(html).toMatch(/aria-activedescendant="[^"]*-2"/)
    expect(html).toContain('>NYK @ ATL<')
    expect(html).toContain('Open until the final buzzer')
  })

  it('summarises the game that closes soonest when nothing is selected', () => {
    const html = night()
    expect(html).toContain('>BOS @ MIL<')
    expect(html).toContain('>41%<')
    expect(html).toContain('>MIL to win<')
  })

  it('passes over a game halted at the final buzzer for one that still trades (R1)', () => {
    const buzzer = evening().map((g) =>
      g.id === 'nba-401810003'
        ? {
            ...g,
            status: 'final' as const,
            markets: [market({ ...g.markets[0], status: 'halted' })],
          }
        : g,
    )
    const html = night({ items: buzzer.map((g) => boardItem(g, undefined, NOW)) })
    expect(html).toContain('>MEM @ CLE<')
    expect(html).toContain('>CLE to win<')
    expect(html).not.toContain('>BOS @ MIL<')
    // Its arc reads closed in ash, never the amber of an emergency halt.
    expect(html).not.toContain('stroke-amber-400')
  })

  it('draws one arc per segment on its ring and lights your game in lume', () => {
    const html = night()
    expect(html).toMatch(/class="stroke-lume-300 opacity-35"/)
    expect(html).toMatch(/stroke-dasharray="2 2.5" class="stroke-brass-500"/)
    expect(html).toMatch(/data-id="nba-401810001" data-ring="1"/)
    expect(html).toContain('data-id="nba-401810004"')
    expect(html).toContain('data-now')
  })

  it('gives every arc a full-ring transparent hit path and keeps the visible arc inert', () => {
    const html = night()
    const paths = html.match(/<path [^>]*>/g) ?? []
    const hits = paths.filter((t) => t.includes('data-hit'))
    const visible = paths.filter(
      (t) => t.includes('stroke-dasharray') || t.includes('class="stroke-'),
    )
    expect(hits.length).toBeGreaterThan(0)
    for (const t of hits) {
      expect(t).toContain('stroke-width="7"')
      expect(t).toContain('stroke="transparent"')
      expect(t).toMatch(/data-id="nba-\d+"/)
    }
    expect(visible).toHaveLength(hits.length)
    for (const t of visible) expect(t).toContain('pointer-events="none"')
  })

  it('keeps the now hand off the centre readout', () => {
    const html = night()
    const line = html.match(/<line [^>]*data-now[^>]*>/)?.[0] ?? ''
    const num = (a: string) => Number(line.match(new RegExp(`${a}="([^"]+)"`))?.[1])
    expect(Math.hypot(num('x1') - 100, num('y1') - 100)).toBeCloseTo(33, 2)
    expect(html).not.toMatch(/<circle [^>]*r="3"/)
    expect(html).toMatch(/<circle [^>]*r="33"[^>]*data-hub|<circle [^>]*data-hub[^>]*r="33"/)
    expect(html).toContain('max-w-[32%]')
  })

  it('shows the empty line and no options without games (spec 4.4)', () => {
    const html = night({ items: [] })
    expect(html).toContain('No NBA games in the next 24 hours.')
    expect(options(html)).toEqual([])
    expect(html).not.toContain('aria-activedescendant')
  })

  it('draws the stale line on the bezel only while polls fail (spec 4.4)', () => {
    expect(night({ stale: true })).toContain('data-stale')
    expect(night()).not.toContain('data-stale')
  })

  it('counts the games past the 8th ring as +N', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      boardItem(game({ id: `g${i}` }), undefined, NOW),
    )
    expect(night({ items: many })).toContain('data-overflow="2"')
  })
})

describe('DialRow (spec 3.2)', () => {
  const cle = boardItem(game(), held, NOW)
  const row = renderToStaticMarkup(<DialRow item={cle} />)

  it('is one link to the game, named by the whole sentence', () => {
    expect(row).toContain('href="/game/nba-401810001"')
    expect(row).toContain(`aria-label="${itemLabel(cle)}"`)
  })

  it('shows the mini dial, the score, whose chance, the % in mono 19 px, the latest ET close and your diamond', () => {
    expect(row).toContain('viewBox="0 0 100 100"')
    expect(row).toContain('78–84 · Q3 4:12')
    expect(row).toContain('data-subject="true">CLE to win</span>')
    expect(row).toContain('font-mono text-19 tabular-nums text-lume-300">77%')
    expect(row).not.toContain('¢')
    expect(row).toContain('latest 10:10 PM ET')
    expect(row).not.toContain('closes')
    expect(row).toContain('◆')
  })

  it('shows the latest close while the market trades, and no time once it stopped', () => {
    const rowOf = (g: ReturnType<typeof game>) =>
      renderToStaticMarkup(<DialRow item={boardItem(g, held, NOW)} />)
    // Minutes from end_ts, the game still in play: the time stays.
    const closing = game({ markets: [market({ endTs: NOW + 130 })] })
    expect(rowOf(closing)).toContain('latest 9:10 PM ET')
    // Halted at the final buzzer, then proposed: trading is over, and R5 says what comes next.
    for (const status of ['halted', 'proposed'] as const) {
      const html = rowOf(game({ status: 'final', markets: [market({ status })] }))
      expect(html).toContain('>result pending<')
      expect(html).not.toContain('latest')
    }
    // Past end_ts with the game still in play, or halted mid-game: no time either.
    const late = rowOf(game({ markets: [market({ endTs: NOW - 60 })] }))
    expect(late).toContain('>trading closed<')
    expect(late).not.toContain('latest')
    const halted = rowOf(game({ markets: [market({ status: 'halted' })] }))
    expect(halted).toContain('>trading halted<')
    expect(halted).not.toContain('latest')
  })

  it('shows the tip-off and the opening time before a market exists', () => {
    const phx = items.find((i) => i.id === 'nba-401810004')
    const html = phx ? renderToStaticMarkup(<DialRow item={phx} />) : ''
    expect(html).toContain('tip-off 10:30 PM ET')
    expect(html).toContain('opens 9:30 PM ET')
    expect(html).toContain('>—<')
    expect(html).not.toContain('◆')
  })
})
