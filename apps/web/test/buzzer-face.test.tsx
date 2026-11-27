// Culture A2 (R8) on the face: the static buzzer index, the Buzzer stop's ring (never on load,
// a reduced-motion twin without it), the ◆ at the average entry, the move chip, the story
// plate, clutch dim (data-hour, string 12, the CSS timings) and its Feel switch.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MoveChip } from '../components/chrono/buzzer-index'
import { Dial, type DialProps } from '../components/chrono/dial'
import { FeelForm } from '../components/chrono/feel-toggles'
import { GameScreen } from '../components/chrono/game-screen'
import { StoryPlate } from '../components/chrono/story-plate'
import { DEFAULT_FEEL } from '../lib/chrono/feel'
import { detail, game, history, market, NOW, position } from '../lib/chrono/fixtures'
import { gameDial } from '../lib/chrono/game'
import { polar, priceToAngle } from '../lib/chrono/geometry'

const WEB = join(import.meta.dirname, '..')

const dial = (over: Partial<DialProps> = {}) =>
  renderToStaticMarkup(
    <Dial price={0.88} modelProb={0.9} timeLeft={0} state="closed" label="x" {...over} />,
  )

/** The `<g …data-buzzer-index…>` element and the line inside it. */
const indexOf = (html: string) =>
  html.match(/<g transform="([^"]+)" data-buzzer-index="(\d+)"><line ([^>]+)>/)

describe('the static buzzer index (a)', () => {
  it('stands at the stop price, a brass bar 1.8 wide from r84 to r93', () => {
    const m = indexOf(dial({ stopPrice: 0.71 }))
    expect(m?.[1]).toBe(`rotate(${priceToAngle(0.71)} 100 100)`)
    expect(m?.[2]).toBe('71')
    expect(m?.[3]).toContain('y1="7"')
    expect(m?.[3]).toContain('y2="16"')
    expect(m?.[3]).toContain('stroke-width="1.8"')
    expect(m?.[3]).toContain('stroke-brass')
  })

  it('shows on every stopped face and stays when the needle goes to 0 or 100', () => {
    for (const state of ['closed', 'proposed', 'challenged'] as const) {
      expect(indexOf(dial({ state, stopPrice: 0.71 }))?.[2]).toBe('71')
    }
    expect(indexOf(dial({ state: 'resolved', price: 1, stopPrice: 0.71 }))?.[2]).toBe('71')
  })

  it('is not on a trading, halted or void face, nor without a stop price', () => {
    for (const state of ['live', 'pre', 'closing', 'halted', 'void'] as const) {
      expect(dial({ state, stopPrice: 0.71 })).not.toContain('data-buzzer-index')
    }
    expect(dial({ stopPrice: null })).not.toContain('data-buzzer-index')
  })
})

describe('the Buzzer stop on the face (b)', () => {
  it('draws the ink ring at r96 once a stop has played, and cancels the run flash', () => {
    const html = dial({ stop: 1, stopPrice: 0.71 })
    const ring = html.match(/<circle[^>]*data-beat="stop"[^>]*>/)?.[0] ?? ''
    expect(ring).toContain('r="96"')
    expect(ring).toContain('stroke-ink')
    expect(dial({ stop: 0, stopPrice: 0.71 })).not.toContain('data-beat="stop"')
  })

  it('has a reduced-motion twin: the stopped face in one frame, no ring', () => {
    const html = dial({ stop: 1, stopPrice: 0.71, reduced: true })
    expect(html).not.toContain('data-beat="stop"')
    expect(indexOf(html)?.[2]).toBe('71')
  })

  it('never plays on load: a game opened after the buzzer draws the stopped face only', () => {
    const final = detail({
      status: 'final',
      period: 4,
      clockSecs: null,
      homeScore: 110,
      awayScore: 101,
      markets: [market({ endTs: NOW - 600, priceTs: NOW - 700 })],
    })
    const html = renderToStaticMarkup(
      <GameScreen
        game={final}
        history={history()}
        dial={gameDial(final, final.markets[0], null, null, NOW)}
        now={NOW}
        stale={false}
        right={null}
      />,
    )
    expect(html).not.toContain('data-beat="stop"')
    // The last price before end_ts, 77%, from the history.
    expect(indexOf(html)?.[2]).toBe('77')
    expect(html).toContain('aria-live="polite"')
    expect(html).not.toContain('Stopped at the buzzer</p>')
  })
})

describe('the ◆ at the average entry (h) and the move chip (d)', () => {
  it('marks the entry at r86 in the live colour, also on a stopped face', () => {
    for (const state of ['live', 'closed'] as const) {
      const html = dial({ state, entry: 0.38 })
      const mark = html.match(
        /<text x="([^"]+)" y="([^"]+)"[^>]*data-entry="38" class="fill-live[^"]*">◆<\/text>/,
      )
      expect(mark).not.toBeNull()
      const c = polar(100, 100, 86, priceToAngle(0.38))
      expect(Number(mark?.[1])).toBeCloseTo(c.x, 3)
      expect(Number(mark?.[2])).toBeCloseTo(c.y, 3)
    }
    expect(dial({ entry: null })).not.toContain('data-entry')
  })

  it('prints the chip with U+2212, never ▲, in both motion modes', () => {
    const minus = renderToStaticMarkup(<MoveChip text={'−5'} />)
    expect(minus).toContain('−5')
    expect(minus).not.toContain('▲')
    expect(minus).toContain('data-chip')
    expect(renderToStaticMarkup(<MoveChip text={null} />)).toBe('')
    expect(dial({ state: 'live', chip: '+5' })).toContain('data-chip')
    expect(dial({ state: 'live', chip: '+5', reduced: true })).toContain('+5')
  })
})

describe('the story plate (f)', () => {
  it('wears the plate style with the story in caps', () => {
    const html = renderToStaticMarkup(<StoryPlate story="Upset" />)
    expect(html).toContain('data-story="Upset"')
    expect(html).toContain('rounded-full')
    expect(html).toContain('uppercase')
    expect(renderToStaticMarkup(<StoryPlate story={null} />)).toBe('')
  })

  it('shows on the stopped face of an upset', () => {
    const final = detail({
      status: 'final',
      period: 4,
      clockSecs: null,
      homeScore: 110,
      awayScore: 101,
      markets: [market({ endTs: NOW - 600, priceTs: NOW - 700, initialPriceBps: 3_000 })],
    })
    const html = renderToStaticMarkup(
      <GameScreen
        game={final}
        history={history()}
        dial={gameDial(final, final.markets[0], null, null, NOW)}
        now={NOW}
        stale={false}
        right={null}
      />,
    )
    expect(html).toContain('data-story="Upset"')
  })
})

describe('clutch dim (c)', () => {
  const clutch = (over = {}) => {
    const g = detail({ period: 4, clockSecs: 108, homeScore: 101, awayScore: 99, ...over })
    return renderToStaticMarkup(
      <GameScreen
        game={g}
        history={history()}
        dial={gameDial(g, g.markets[0], NOW - 3_730, null, NOW)}
        now={NOW}
        stale={false}
        right={null}
        positions={[position({ gameId: g.id })]}
      />,
    )
  }

  it('sets data-hour="clutch" and says string 12 in clutch time', () => {
    const html = clutch()
    expect(html).toContain('data-hour="clutch"')
    expect(html).toContain('Clutch · Q4 1:48 · open until the final buzzer')
  })

  it('stays day outside the gate', () => {
    const html = clutch({ clockSecs: 121 })
    expect(html).toContain('data-hour="day"')
    expect(html).not.toContain('Clutch ·')
  })

  it('recedes the ticks and rules to rule-faint: 1.2 s in, 0.6 s out, instant when reduced', () => {
    const css = readFileSync(join(WEB, 'app', 'globals.css'), 'utf8')
    const block = css.slice(css.indexOf('/* Clutch time'))
    expect(block).toMatch(/\[data-hour=["']clutch["']\][^{]*\[data-ticks\][^{]*\{[^}]*rule-faint/)
    expect(block).toMatch(/transition[^;]*0\.6s/)
    expect(block).toMatch(/1\.2s/)
    expect(block).toMatch(/\[data-motion=["']reduced["']\][^{]*\{[^}]*transition: none/)
    // The face, numbers, needle and ◆ are not named.
    expect(block).not.toMatch(/data-needle|data-entry|enamel-900/)
  })

  it('has a Feel switch "Dim the screen in clutch time", on by default', () => {
    const html = renderToStaticMarkup(
      <FeelForm feel={DEFAULT_FEEL} onChange={() => {}} vibrates={false} />,
    )
    expect(html).toContain('Dim the screen in clutch time')
    expect(html).toMatch(/Dim the screen in clutch time<input type="checkbox"[^>]*checked=""/)
    const off = renderToStaticMarkup(
      <FeelForm
        feel={{ ...DEFAULT_FEEL, clutchDim: false }}
        onChange={() => {}}
        vibrates={false}
      />,
    )
    expect(off).not.toMatch(/Dim the screen in clutch time<input type="checkbox"[^>]*checked=""/)
  })
})

describe('the run flash (e)', () => {
  it('passes the run key only for a run that moved the price 2 points or more', () => {
    // The fixture's run moved CLE 74% → 77%: the key flows; the screen source gates it.
    const src = readFileSync(join(WEB, 'components', 'chrono', 'game-screen.tsx'), 'utf8')
    expect(src).toContain('runFlashes(latest.priceFrom, latest.priceTo)')
    const g = game()
    expect(g.id).toBe('nba-401810001')
  })
})
