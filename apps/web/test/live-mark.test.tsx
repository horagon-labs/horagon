// The live-mark test (light branding review §3.2, §8 risk 2; j-build G5). Live means one thing:
// the market is open, before tip-off too, plus your ◆. The old names lie (`stroke-lume-300` paints
// ink), so a live mark left on one would ship black without a word; this file turns that into a
// red test, and checks that live never colours a word.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Dial } from '../components/chrono/dial'
import { needleClass, RING, ringClass } from '../components/chrono/dial-look'
import { DialRow } from '../components/chrono/dial-row'
import { MiniDial } from '../components/chrono/mini-dial'
import { NightDial } from '../components/chrono/night-dial'
import { PositionCard } from '../components/chrono/position-card'
import { Tape } from '../components/chrono/tape'
import { Wordmark } from '../components/chrono/wordmark'
import { YourHour } from '../components/chrono/your-hour'
import { ShareGauge } from '../components/share-card'
import { boardItem, rowWords } from '../lib/chrono/board'
import { at, game, history, market, NOW, portfolio, position } from '../lib/chrono/fixtures'
import { DIAL_STATES, type DialState, isTrading } from '../lib/chrono/state'
import { MARKET_LINE } from '../lib/chrono/tape'
import { COLORS } from '../lib/chrono/tokens'
import { ICON_COLORS } from '../lib/icons'

const OPEN: DialState[] = ['pre', 'live', 'closing']
const STOPPED = DIAL_STATES.filter((s) => !isTrading(s))
const held = portfolio([position()])
/** A market open before tip-off (it opens 60 min ahead): live already. */
const early = game({
  id: 'nba-early',
  status: 'scheduled',
  homeScore: 0,
  awayScore: 0,
  period: 0,
  clockSecs: null,
  scheduledTipoff: new Date((NOW + 1_800) * 1000).toISOString(),
  markets: [market({ pubkey: 'MktEarly111111111111111111111111111111111111', endTs: NOW + 9_000 })],
})
/** No market yet: quiet, ink-muted. */
const later = game({
  id: 'nba-later',
  status: 'scheduled',
  homeScore: 0,
  awayScore: 0,
  period: 0,
  clockSecs: null,
  scheduledTipoff: new Date(at('2026-11-25T03:30:00Z') * 1000).toISOString(),
  markets: [],
})

describe('live: the market is open (review §3.2)', () => {
  it('draws the needle live while the market trades, before tip-off too, and muted after', () => {
    for (const s of OPEN) expect(needleClass(s), s).toBe('stroke-live')
    for (const s of STOPPED) expect(needleClass(s), s).toBe('stroke-ash-400')
  })

  it('draws the ring live while live or closing, and live before tip-off only with a market', () => {
    expect(RING.live).toBe('stroke-live')
    expect(RING.closing).toBe('stroke-live')
    expect(ringClass('pre', true)).toBe('stroke-live')
    expect(ringClass('pre', false)).toBe('stroke-ash-400')
    for (const s of DIAL_STATES.filter((x) => x !== 'pre')) {
      expect(ringClass(s, true), s).toBe(RING[s])
      expect(ringClass(s, false), s).toBe(RING[s])
    }
    for (const s of STOPPED) expect(RING[s], s).not.toBe('stroke-live')
  })

  it('draws the priced ghost live and whole, the pending one as a plain rule', () => {
    const dial = (pending: boolean) =>
      renderToStaticMarkup(
        <Dial
          price={0.77}
          modelProb={0.74}
          timeLeft={0.5}
          state="live"
          label="x"
          ghostPrice={0.8}
          ghostPending={pending}
        />,
      )
    const ghost = (html: string) =>
      html.match(/<g [^>]*class="([^"]*)"[^>]*data-needle="ghost"/)?.[1]
    expect(ghost(dial(false))).toBe('stroke-live')
    expect(ghost(dial(true))).toBe('stroke-line')
    expect(dial(false)).not.toMatch(/opacity-\d/)
  })

  it('gives a MiniDial open before tip-off the live ring and needle, and one with no market none', () => {
    const e = boardItem(early, undefined, NOW)
    const l = boardItem(later, undefined, NOW)
    expect([e.state, l.state]).toEqual(['pre', 'pre'])
    const mini = (i: typeof e) =>
      renderToStaticMarkup(<MiniDial price={i.price} timeLeft={i.timeLeft} state={i.state} />)
    expect(mini(e)).toMatch(/class="stroke-live" data-ring/)
    expect(mini(e)).toMatch(/class="stroke-live" data-needle="price"/)
    expect(mini(l)).toMatch(/class="stroke-ash-400" data-ring/)
    expect(mini(l)).not.toContain('data-needle')
  })

  it('draws a Night arc live for an open market, and muted for no market or a stopped one', () => {
    const items = [game(), early, later, game({ id: 'nba-final', status: 'final' })].map((g) =>
      boardItem(g, undefined, NOW),
    )
    const html = renderToStaticMarkup(
      <NightDial items={items} now={NOW} selectedId={null} onSelect={() => {}} emptyText="" />,
    )
    const arcs = (id: string) =>
      [...html.matchAll(/<g><path [^>]*class="([^"]*)"[^>]*><\/path><path [^>]*data-id="([^"]+)"/g)]
        .filter((m) => m[2] === id)
        .map((m) => m[1] ?? '')
    for (const id of ['nba-401810001', 'nba-early']) {
      expect(arcs(id).length, id).toBeGreaterThan(0)
      for (const c of arcs(id)) expect(c, id).toMatch(/^stroke-live\b/)
    }
    for (const id of ['nba-later', 'nba-final']) {
      expect(arcs(id).length, id).toBeGreaterThan(0)
      for (const c of arcs(id)) expect(c, id).toMatch(/^stroke-ash-400\b/)
    }
  })

  it('draws the Tape market line and its legend live', () => {
    expect(MARKET_LINE).toEqual({ color: COLORS.live, lineWidth: 2 })
    const html = renderToStaticMarkup(
      <Tape history={history()} market={market().pubkey} home="CLE" away="MEM" />,
    )
    expect(html).toContain('<span class="text-live">━ Market (CLE to win)</span>')
  })

  it('draws the share gauge live while the market trades, and muted after', () => {
    expect(renderToStaticMarkup(<ShareGauge price={0.62} size={420} />)).toContain(
      `stroke="${COLORS.live}"`,
    )
    const after = renderToStaticMarkup(<ShareGauge price={0.62} size={420} live={false} />)
    expect(after).not.toContain(COLORS.live)
    expect(after).toContain(`stroke="${COLORS['ash-400']}"`)
  })

  it('gives the mark a live needle, in the header and on every home-screen icon', () => {
    expect(ICON_COLORS.needle).toBe(COLORS.live)
    const html = renderToStaticMarkup(<Wordmark />)
    expect(html).toMatch(new RegExp(`<path d="[^"]+" stroke="${COLORS.live}"`))
  })

  it('keeps the game clock dot ink: it says the clock runs, not that the market is open', () => {
    const html = renderToStaticMarkup(
      <Dial
        price={0.77}
        modelProb={0.74}
        timeLeft={0.5}
        state="live"
        label="x"
        liveDot
        caption="CLE to win"
      />,
    )
    expect(html).not.toMatch(/bg-live[^>]*data-live/)
  })
})

describe('yours: ◆ in live, the shape tells it apart (review §3.2 row 15)', () => {
  it('marks your game on the board row with a live ◆, and leaves the MiniDial rim alone', () => {
    const row = renderToStaticMarkup(<DialRow item={boardItem(game(), held, NOW)} />)
    expect(row).toContain('<span class="text-15 text-live">◆</span>')
    const bare = renderToStaticMarkup(<DialRow item={boardItem(game(), undefined, NOW)} />)
    const rim = (html: string) => html.match(/<circle [^>]*data-rim/)?.[0]
    expect(rim(row)).toBe(rim(bare))
    expect(bare).not.toContain('◆')
  })

  it('puts a live ◆ before the Night label of your game', () => {
    const html = renderToStaticMarkup(
      <NightDial
        items={[boardItem(game(), held, NOW)]}
        now={NOW}
        selectedId={null}
        onSelect={() => {}}
        emptyText=""
      />,
    )
    expect(html).toMatch(/<tspan class="fill-live">◆ <\/tspan>CLE<\/text>/)
    const mine = (html.match(/<g><path [^>]*class="([^"]*)"/g) ?? []).join(' ')
    expect(mine).not.toContain('lume')
  })

  it('marks both sides of your position with the same live ◆ (teams have no colour)', () => {
    const html = renderToStaticMarkup(
      <PositionCard
        gameId="nba-401810001"
        teams={{ home: 'CLE', away: 'MEM' }}
        portfolio={portfolio([position(), position({ side: 'away', market: 'Mkt2' })])}
        canSell
        onSell={() => {}}
        claiming={false}
        claimed={[]}
        claimError={null}
        onClaim={() => {}}
      />,
    )
    expect(html.match(/<span aria-hidden="true" class="text-live">◆<\/span>/g)).toHaveLength(2)
  })

  it('marks the header chip with a live ◆ and ink figures', () => {
    const html = renderToStaticMarkup(<YourHour portfolio={held} onOpen={() => {}} />)
    expect(html).toContain('<span class="text-live">◆</span>')
  })
})

describe('closing reads "closes in m:ss" on the board row (review §10 item 9)', () => {
  it('replaces "latest …" in the last five minutes, and keeps it before', () => {
    const closing = boardItem(game({ markets: [market({ endTs: NOW + 130 })] }), undefined, NOW)
    expect(closing.state).toBe('closing')
    expect(rowWords(closing).note).toBe('closes in 2:10')
    expect(rowWords(boardItem(game(), undefined, NOW)).note).toBe('latest 10:10 PM ET')
  })
})

describe('live never colours a word (u3 §3.2: live numbers are ink)', () => {
  const root = join(import.meta.dirname, '..')
  const sources = ['app', 'components', 'lib'].flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => join(dir, file)),
  )

  it('uses text-live and fill-live only on a ◆ or the Tape legend', () => {
    const uses: string[] = []
    for (const file of sources) {
      const text = readFileSync(join(root, file), 'utf8')
      expect(text.match(/(?:text|fill)-live\b/g)?.length ?? 0, file).toBe(
        [...text.matchAll(/className="[^"]*\b(?:text|fill)-live\b[^"]*"[^>]*>([^<]*)</g)].length,
      )
      // The element's own text, wherever the formatter breaks the line.
      for (const m of text.matchAll(
        /className="[^"]*\b(?:text|fill)-live\b[^"]*"[^>]*>([^<]*)</g,
      )) {
        uses.push(`${file}: ${(m[1] ?? '').trim()}`)
      }
    }
    expect(uses.length).toBeGreaterThan(0)
    for (const use of uses) expect(use).toMatch(/: (?:◆ ?|━ Market \(\{props\.home\} to win\))$/)
  })

  it('never draws a needle, ring, arc, ghost or ◆ in an ink-named old token', () => {
    const marks = [
      RING.live,
      RING.closing,
      ...OPEN.map(needleClass),
      ringClass('pre', true),
      MARKET_LINE.color,
      ICON_COLORS.needle,
    ]
    for (const m of marks) expect(m).not.toMatch(/lume-300|brass-500|brass-400|amber-400/)
  })
})
