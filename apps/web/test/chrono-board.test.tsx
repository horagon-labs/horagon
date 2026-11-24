import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BoardView, type BoardViewProps } from '../components/chrono/board-view'
import { Gallery } from '../components/chrono/gallery'
import { boardModel } from '../lib/chrono/board'
import { evening, NOW, portfolio, position } from '../lib/chrono/fixtures'
import { pollHealth } from '../lib/chrono/health'
import { DIAL_STATES } from '../lib/chrono/state'

const noop = () => {}
const OK = { stale: false, error: undefined }

const board = (over: Partial<BoardViewProps> = {}) =>
  renderToStaticMarkup(
    <BoardView
      games={evening()}
      portfolio={portfolio([position()])}
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

describe('pollHealth (spec 4.4)', () => {
  const err = new Error('down')

  it('turns stale at the first failure and shows the error from the third', () => {
    expect(pollHealth({ error: undefined, failures: 0 })).toEqual({
      stale: false,
      error: undefined,
    })
    expect(pollHealth({ error: err, failures: 1 })).toEqual({ stale: true, error: undefined })
    expect(pollHealth({ error: err, failures: 2 })).toEqual({ stale: true, error: undefined })
    expect(pollHealth({ error: err, failures: 3 })).toEqual({ stale: true, error: err })
  })
})

describe('boardModel (spec 4.1, 4.4)', () => {
  it('orders tonight: soonest close first, then by tip-off', () => {
    const m = boardModel(evening(), undefined, NOW, [])
    expect(m.items.map((i) => i.game.home)).toEqual(['MIL', 'CLE', 'ATL', 'PHX', 'SAC'])
    expect(m.teams).toEqual(['ATL', 'BOS', 'CLE', 'DEN', 'LAL', 'MEM', 'MIL', 'NYK', 'PHX', 'SAC'])
    expect(m.empty).toBeNull()
  })

  it('keeps only the followed teams and keeps every chip', () => {
    const m = boardModel(evening(), undefined, NOW, ['MEM'])
    expect(m.items.map((i) => i.id)).toEqual(['nba-401810001'])
    expect(m.teams).toHaveLength(10)
  })

  it('keeps the words of the loading and empty boards', () => {
    expect(boardModel(undefined, undefined, NOW, []).empty).toBe('Loading games…')
    expect(boardModel([], undefined, NOW, []).empty).toBe('No NBA games in the next 24 hours.')
    expect(boardModel(evening(), undefined, NOW, ['TOR']).empty).toBe(
      'No games for the teams you follow in the next 24 hours.',
    )
  })

  it('moves the Night dial clock up to the newest price time on the board (spec 5.4)', () => {
    const ahead = evening().map((g) => ({
      ...g,
      markets: g.markets.map((m) => ({ ...m, priceTs: NOW + 30 })),
    }))
    expect(boardModel(ahead, undefined, NOW, []).chainNow).toBe(NOW + 30)
    expect(boardModel(evening(), undefined, NOW, []).chainNow).toBe(NOW)
    expect(boardModel(undefined, undefined, NOW, []).chainNow).toBe(NOW)
  })
})

describe('BoardView (spec 4.1, 4.4)', () => {
  it('draws the Night dial and one row link per game', () => {
    const html = board()
    expect(html).toContain('role="listbox"')
    expect(html.match(/href="\/game\//g)).toHaveLength(5)
    expect(html).toContain('aria-pressed="false"')
  })

  it('lights the hovered row', () => {
    const links = [...board({ hoverId: 'nba-401810002' }).matchAll(/<a [^>]*>/g)].map((m) => m[0])
    const lit = links.filter((a) => a.includes('data-lit="true"'))
    expect(lit).toHaveLength(1)
    expect(lit[0]).toContain('href="/game/nba-401810002"')
  })

  it('marks a failing poll as reconnecting and keeps the rows', () => {
    const html = board({ health: { stale: true, error: undefined } })
    expect(html).toContain('Reconnecting…')
    expect(html).toContain('data-stale')
    expect(html.match(/href="\/game\//g)).toHaveLength(5)
    expect(html).not.toContain('Something went wrong')
  })

  it('shows the error text after three failures, without the loading line', () => {
    const html = board({ games: undefined, health: { stale: true, error: new Error('down') } })
    expect(html).toContain('Something went wrong. Try again.')
    expect(html).not.toContain('Loading games…')
  })

  it('says the loading and empty lines on the dial and to screen readers', () => {
    const loading = board({ games: undefined })
    expect(loading.match(/Loading games…/g)).toHaveLength(2)
    expect(board({ games: [] })).toContain('<p role="status" class="sr-only">No NBA games')
  })
})

describe('dev gallery (spec 6.2)', () => {
  it('draws every DialState and never prints NaN', () => {
    const html = renderToStaticMarkup(<Gallery />)
    for (const state of DIAL_STATES) expect(html, state).toContain(`dial dial-${state} `)
    expect(html).not.toContain('NaN')
  })
})
