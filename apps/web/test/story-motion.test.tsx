// First screen, slice 5 "Motion and live swap" (first-screen spec §4, G1, G4, §5 C17, §11 row 5):
// the story's line draws once on first paint and stops, the low's ring and the readout fade in
// after it, reduced motion shows the end frame at once, and a market opening under the poll swaps
// the idle face for the Night dial, the count line and the compact story, with no reload. Motion
// lives in globals.css classes only: no style attribute and no script (R9 CSP). Pure markup and
// source: no API, no DB.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Game, type Night, type NightGame, NightSchema } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BoardView, type BoardViewProps } from '../components/chrono/board-view'
import { StoryCard } from '../components/story-card'
import { TonightBoard } from '../components/tonight-board'
import { WalletProvider } from '../components/wallet'
import { faceGone, marketOpen } from '../lib/chrono/board'
import { at, game, market } from '../lib/chrono/fixtures'
import { type ScreenState, screenState } from '../lib/server/first-screen'
import type { InitialBoard } from '../lib/server/initial'

// TonightBoard's poll and clock, for its render tests: the games a tick answered and the
// browser's clock. Unset, the board shows the server's first frame (no answer, clock 0 while
// hydrating), and nothing else here calls either.
const stub = vi.hoisted(() => ({ games: undefined as Game[] | undefined, now: 0 }))
vi.mock('../lib/use-poll', () => ({
  POLL_MS: 3_000,
  usePoll: (key: string | null) => ({
    data: key === 'games' ? stub.games : undefined,
    error: undefined,
    failures: 0,
    refresh: () => {},
  }),
}))
vi.mock('../lib/chrono/now', async (actual) => ({
  ...(await actual<typeof import('../lib/chrono/now')>()),
  useNow: () => stub.now,
}))

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
const S2_NOW = at('2026-11-27T08:16:00Z')

const LIVE = /\b(text|bg|stroke|fill|border)-live\b/

type Attrs = Record<string, string>
const attrs = (s: string): Attrs =>
  Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
const tags = (html: string, name: string): Attrs[] =>
  [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'g'))].map((m) => attrs(m[1] ?? ''))
const svgs = (html: string) => [
  ...html.matchAll(/<svg viewBox="0 0 (?:340|600) \d+"[\s\S]*?<\/svg>/g),
]
const masks = (svg: string) =>
  [...svg.matchAll(/<mask\b([^>]*)>([\s\S]*?)<\/mask>/g)].map((m) => ({
    mask: attrs(m[1] ?? ''),
    paths: tags(m[2] ?? '', 'path'),
  }))

/** One CSS rule's body by its exact selector (top level, no nesting). */
const rule = (css: string, selector: string) => {
  const at_ = css.indexOf(`${selector} {`)
  if (at_ < 0) return null
  return css.slice(css.indexOf('{', at_) + 1, css.indexOf('}', at_))
}
const keyframes = (css: string, name: string) =>
  css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? null

describe('the story draws once in CSS, the end frame as its base (§4, G1)', () => {
  const css = read('app', 'globals.css')

  it('draws the line with stroke-dashoffset 1 → 0 on pathLength 1, 2.4 s ease-out, once', () => {
    const k = keyframes(css, 'story-draw')
    expect(k).not.toBeNull()
    expect(k).toMatch(/from\s*\{\s*stroke-dashoffset:\s*1;?\s*\}/)
    expect(k).toMatch(/to\s*\{\s*stroke-dashoffset:\s*0;?\s*\}/)
    const draw = rule(css, '.story-draw')
    expect(draw).not.toBeNull()
    // The base style is the end frame: the whole line, so no animation shows it all.
    expect(draw).toMatch(/stroke-dasharray:\s*1 1;/)
    expect(draw).toMatch(/stroke-dashoffset:\s*0;/)
    expect(draw).toMatch(/animation:\s*story-draw 2\.4s ease-out both;/)
    expect(draw).not.toContain('infinite')
  })

  it('fades the low ring and the readout in over 0.3 s once the line is drawn', () => {
    const k = keyframes(css, 'story-at-low')
    expect(k).toMatch(/from\s*\{\s*opacity:\s*0;?\s*\}/)
    const low = rule(css, '.story-at-low')
    expect(low).not.toBeNull()
    expect(low).toMatch(/animation:\s*story-at-low 0\.3s ease-out 2\.4s both;/)
    // Never hidden in its base style: with no animation it shows.
    expect(low).not.toMatch(/opacity:\s*0/)
    expect(low).not.toContain('infinite')
  })

  it('leaves reduced motion to the one block above: animation none, end frame shown', () => {
    const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1]
    expect(block).toMatch(/\*:not\(\.keep-motion\)\s*\{\s*animation: none;/)
    expect(css).toMatch(
      /html\[data-motion="reduced"\] \*:not\(\.keep-motion\)\s*\{\s*animation: none;/,
    )
    // Unlayered and after the theme, so the draw beats no utility and the block beats the draw.
    expect(css.indexOf('.story-draw {')).toBeGreaterThan(
      css.indexOf('@media (prefers-reduced-motion'),
    )
    // Decoration, not progress: no story part opts out of reduced motion.
    const story = read('components', 'story-card.tsx')
    expect(story).not.toContain('keep-motion')
  })
})

describe('the full card wires the draw with classes only (§4, R9 CSP)', () => {
  const html = renderToStaticMarkup(
    <StoryCard story={{ night: REAL, game: MIN_OKC }} now={S2_NOW} />,
  )

  it('draws each tape through a mask whose path is the model line on pathLength 1', () => {
    const both = svgs(html)
    expect(both).toHaveLength(2)
    const ids = new Set<string>()
    for (const [svg] of both) {
      const model = tags(svg, 'path').find((p) => 'data-tape-model' in p)
      expect(model).toBeDefined()
      // The visible line keeps its dashes; the mask draws it.
      expect(model?.['stroke-dasharray']).toBe('4 3')
      const ref = model?.mask?.match(/^url\(#([\w-]+)\)$/)?.[1]
      expect(ref).toBeDefined()
      const ms = masks(svg)
      const m = ms.find((x) => x.mask.id === ref)
      expect(m).toBeDefined()
      // A flat line has a zero-height box: the mask region is the svg's own, not the line's.
      expect(m?.mask.maskUnits).toBe('userSpaceOnUse')
      const [draw] = m?.paths ?? []
      expect(draw?.d).toBe(model?.d)
      expect(draw?.pathLength).toBe('1')
      expect(draw?.class).toBe('story-draw')
      expect(draw?.stroke).toBe('white')
      ids.add(ref ?? '')
    }
    // Two svgs on one page: every mask id is its own.
    expect(ids.size).toBe(2)
    expect(new Set(tags(html, 'mask').map((m) => m.id)).size).toBe(tags(html, 'mask').length)
  })

  it('fades the ring and the low % in after the draw; the open, final and quarters stay still', () => {
    const groups = [...html.matchAll(/<g class="story-at-low"[^>]*>([\s\S]*?)<\/g>/g)]
    expect(groups).toHaveLength(2)
    for (const [, g] of groups) {
      expect(g).toContain('data-tape-low')
      expect(g).toMatch(/>7%<\/text>/)
      expect(g).not.toContain('opened')
      expect(g).not.toContain('Final')
    }
    expect(html).toMatch(/class="[^"]*hidden[^"]*sm:flex[^"]*\bstory-at-low\b[^"]*" data-readout/)
    expect(html.match(/story-at-low/g)).toHaveLength(3)
  })

  it('keeps the card free of style attributes, scripts and Live blue', () => {
    expect(html).not.toContain('style=')
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(LIVE)
  })

  it('draws the price line too on a moved night, each line through its own mask', () => {
    const moved = renderToStaticMarkup(
      <StoryCard story={{ night: MOVED_NIGHT, game: MOVED }} now={S2_NOW} />,
    )
    for (const [svg] of svgs(moved)) {
      const price = tags(svg, 'path').find((p) => 'data-tape-price' in p)
      const ref = price?.mask?.match(/^url\(#([\w-]+)\)$/)?.[1]
      const m = masks(svg).find((x) => x.mask.id === ref)
      expect(m?.paths[0]?.d).toBe(price?.d)
      expect(m?.paths[0]?.class).toBe('story-draw')
      expect(masks(svg)).toHaveLength(2)
    }
    expect(new Set(tags(moved, 'mask').map((m) => m.id)).size).toBe(4)
    expect(moved).not.toContain('style=')
    expect(moved.match(/story-at-low/g)).toHaveLength(3)
  })

  it('keeps the compact card still: no tape, nothing to draw or fade', () => {
    const compact = renderToStaticMarkup(
      <StoryCard story={{ night: REAL, game: MIN_OKC }} now={S2_NOW} variant="compact" />,
    )
    expect(compact).not.toContain('story-draw')
    expect(compact).not.toContain('story-at-low')
  })

  it('ships no motion code: the classes live in no client module', () => {
    const files = (dir: string): string[] =>
      readdirSync(join(WEB, dir), { recursive: true, encoding: 'utf8' })
        .filter((f) => /\.(ts|tsx)$/.test(f))
        .map((f) => join(dir, f))
    for (const f of [...files('components'), ...files('lib'), ...files('app')]) {
      const src = read(f)
      if (!/^['"]use client['"]/m.test(src)) continue
      expect(src, f).not.toMatch(/story-draw|story-at-low/)
    }
    const story = read('components', 'story-card.tsx')
    expect(story).not.toMatch(/^['"]use client['"]/m)
    expect(story).not.toMatch(/useEffect|from 'motion/)
  })
})

describe('a market opening under the poll swaps the idle face, no reload (G4, C17)', () => {
  const noop = () => {}
  const OK = { stale: false, error: undefined }
  const sched = (id: string, away: string, home: string, tip: string, p: number): Game =>
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
    sched('nba-401909326', 'MIA', 'NYK', '2026-11-28T00:00:00.000Z', 0.788),
    sched('nba-401909327', 'MIL', 'DET', '2026-11-28T00:30:00.000Z', 0.917),
  ]
  // 5:58 PM ET: S2, no market open yet.
  const S2_LATER = at('2026-11-27T22:58:00Z')
  // 7:00 PM ET minus 59 min: NYK's market has just opened at the model's chance.
  const OPEN_NOW = at('2026-11-27T23:01:00Z')
  const opened = (n: number) =>
    friday().map((g, i) =>
      i < n
        ? {
            ...g,
            markets: [
              market({
                pubkey: `Mkt${i}`,
                initialPriceBps: Math.round((g.modelProb ?? 0.5) * 10_000),
                price: g.modelProb,
                priceTs: OPEN_NOW - 5,
                endTs: at(i === 0 ? '2026-11-28T05:32:00Z' : '2026-11-28T06:02:00Z'),
              }),
            ],
          }
        : g,
    )
  const board = (over: Partial<BoardViewProps> = {}) =>
    renderToStaticMarkup(
      <BoardView
        games={friday()}
        portfolio={undefined}
        now={at('2026-11-27T22:58:00Z')}
        health={OK}
        follows={[]}
        onToggleFollow={noop}
        selectedId={null}
        onSelect={noop}
        hoverId={null}
        onHover={noop}
        idleFace={<p data-test-face>FACE</p>}
        idleFoot={<p data-test-foot>FOOT</p>}
        openFoot={<p data-test-open>COMPACT</p>}
        {...over}
      />,
    )

  it('S2: the face and its foot show; the compact story waits', () => {
    const html = board()
    expect(html).toContain('data-test-face')
    expect(html).toContain('data-test-foot')
    expect(html).not.toContain('data-test-open')
    expect(html).toContain('First market opens in 2 min')
  })

  it('the next poll with NYK open: the Night dial, "● 1 market open now", then the compact story', () => {
    const html = board({ games: opened(1), now: OPEN_NOW })
    expect(html).not.toContain('data-test-face')
    expect(html).not.toContain('data-test-foot')
    expect(html).toContain('role="listbox"')
    expect(html).toMatch(
      /<p [^>]*data-count[^>]*><span aria-hidden="true" class="text-live">●<\/span> 1 market open now · <a href="#first-open"[^>]*>Pick a game<\/a><\/p>/,
    )
    expect(html).toMatch(/<a [^>]*id="first-open"[^>]*href="\/game\/nba-401909326"/)
    // The compact story follows the board (dial and list), as the server lays out S3.
    const open = html.indexOf('data-test-open')
    expect(open).toBeGreaterThan(html.indexOf('role="listbox"'))
    expect(open).toBeGreaterThan(html.indexOf('data-board-list'))
    expect(html).toMatch(/<div data-open-foot="true"><p data-test-open="true">COMPACT<\/p><\/div>$/)
  })

  it('says "2 markets open now" for two', () => {
    expect(board({ games: opened(2), now: OPEN_NOW })).toContain(' 2 markets open now · ')
  })

  it('S3 from the server: no face given, the compact story follows the board at once', () => {
    const html = board({
      games: opened(1),
      now: OPEN_NOW,
      idleFace: undefined,
      idleFoot: undefined,
    })
    expect(html).toContain('data-test-open')
    expect(html).toContain('role="listbox"')
  })

  it('without an open foot the board markup is as before', () => {
    const without = board({ games: opened(1), now: OPEN_NOW, openFoot: undefined })
    expect(without).not.toContain('data-open-foot')
    expect(without.startsWith('<div class="flex flex-col gap-4 lg:grid')).toBe(true)
  })

  // Refix 1: the swap holds until a reload. The idle face is the server's, for the state it saw (a
  // page loaded in S2 holds the story of the night before). When the night's last market stops
  // and no market is open, bringing that face back would retell the old night under the board's
  // "All stopped." (S5 tells the night that just ended, which only the server knows), and its
  // tape would draw again. Once the poll has seen a market open, the page stays as one loaded in
  // S3/S4.
  // 10:40 PM ET: both games final, NYK's draft proposed; the ET night is over.
  const NIGHT_OVER = at('2026-11-28T03:40:00Z')
  const stopped = (): Game[] =>
    opened(1).map((g) => ({
      ...g,
      status: 'final',
      homeScore: 108,
      awayScore: 101,
      period: 4,
      clockSecs: null,
      markets: g.markets.map((m) => ({
        ...m,
        status: 'proposed',
        outcome: 'yes',
        price: 0.97,
        priceTs: NIGHT_OVER - 600,
      })),
    }))

  it('a market open takes the slot from any face, by the rule the server picks S3/S4 by', () => {
    // The same rule the server picks S3/S4 by: a listed winner market trades now.
    expect(marketOpen(friday(), S2_LATER)).toBe(false)
    expect(marketOpen(opened(1), OPEN_NOW)).toBe(true)
    expect(marketOpen(stopped(), NIGHT_OVER)).toBe(false)
    expect(marketOpen(undefined, OPEN_NOW)).toBe(false)
    for (const built of ['rest', 'later', 'after'] as const) {
      // S2: no market open and the night not over, so every idle face stays.
      expect(faceGone(built, friday(), S2_LATER), built).toBe(false)
      expect(faceGone(built, undefined, S2_LATER), built).toBe(false)
      expect(faceGone(built, opened(1), OPEN_NOW), built).toBe(true)
    }
  })

  // Refix 2: holding the swap only helps while the poll runs. usePoll skips every tick while the
  // tab is hidden and no timer runs while the machine sleeps, so a page loaded in S2 during the
  // day and looked at again after the last game may see the night over first, with no open seen
  // in between. Its face (the night before) would sit under "All stopped." where S5 tells the
  // night that just ended. Only a face the server built for S5 fits a night that is over.
  it('drops a face built before the night ended once the poll sees the night over', () => {
    expect(faceGone('later', stopped(), NIGHT_OVER)).toBe(true)
    expect(faceGone('rest', stopped(), NIGHT_OVER)).toBe(true)
    // After midnight ET and before the 06:00 rollover it is still the night that just ended.
    expect(faceGone('later', stopped(), at('2026-11-28T05:30:00Z'))).toBe(true)
    expect(faceGone('after', stopped(), at('2026-11-28T05:30:00Z'))).toBe(false)
    // An S5 face tells the night that just ended: it stays.
    expect(faceGone('after', stopped(), NIGHT_OVER)).toBe(false)
    // An S1 or S2 page whose poll saw the night end the usual way: the open dropped it first.
    expect(faceGone('later', opened(1), OPEN_NOW)).toBe(true)
  })

  it('counts every listed market, whatever the follow filter shows, as the server does', () => {
    // Following DET only: the filtered board counts no open market, but NYK's is open, so a
    // reload would lay out S3 (no face). The poll's swap follows the server, not the filter.
    const filtered = board({ games: opened(1), now: OPEN_NOW, follows: ['DET'] })
    expect(filtered).not.toContain(' open now ·')
    expect(marketOpen(opened(1), OPEN_NOW)).toBe(true)
    expect(screenState(opened(1), OPEN_NOW)).toBe('preopen')
  })

  it('the held page at the night\'s end: the dial and "All stopped.", the compact story, no face', () => {
    // TonightBoard hands no face once the swap is held.
    const html = board({
      games: stopped(),
      now: NIGHT_OVER,
      idleFace: undefined,
      idleFoot: undefined,
    })
    expect(html).not.toContain('data-test-face')
    expect(html).not.toContain('data-test-foot')
    expect(html).toContain('role="listbox"')
    expect(html).toMatch(/<p [^>]*data-stopped[^>]*>All stopped\.<\/p>/)
    expect(html).toMatch(/<div data-open-foot="true"><p data-test-open="true">COMPACT<\/p><\/div>$/)
    // The count line has nothing open to count, so no Live-blue dot.
    expect(html).not.toContain('data-count')
  })

  // TonightBoard itself, its poll and clock stubbed (web tests have no DOM): one render with what
  // the poll answered, as the browser renders it after a tick.
  const tonight = (p: {
    initial: InitialBoard
    state?: ScreenState
    poll?: Game[]
    now?: number
  }) => {
    stub.games = p.poll
    stub.now = p.now ?? 0
    try {
      return renderToStaticMarkup(
        <WalletProvider>
          <TonightBoard
            initial={p.initial}
            state={p.state}
            idleFace={<p data-test-face>FACE</p>}
            idleFoot={<p data-test-foot>FOOT</p>}
            openFoot={<p data-test-open>COMPACT</p>}
          />
        </WalletProvider>,
      )
    } finally {
      stub.games = undefined
      stub.now = 0
    }
  }
  const S2_FIRST = { games: friday(), upcoming: null, now: S2_LATER }

  it('an S2 page whose first tick comes after the last game shows no S2 face under "All stopped."', () => {
    // Loaded in S2 in the day, the tab hidden (or the machine asleep) all evening: the first tick
    // on its return sees only stopped games, and no market was ever seen open.
    const html = tonight({ initial: S2_FIRST, state: 'later', poll: stopped(), now: NIGHT_OVER })
    expect(html).toMatch(/<p [^>]*data-stopped[^>]*>All stopped\.<\/p>/)
    expect(html).not.toContain('data-test-face')
    expect(html).not.toContain('data-test-foot')
    expect(html).toContain('role="listbox"')
    expect(html).toContain('<div data-open-foot="true"><p data-test-open="true">COMPACT</p></div>')
  })

  it('an S1 page the same: its face told an older night too', () => {
    const html = tonight({
      initial: { games: [], upcoming: null, now: at('2026-11-27T08:16:00Z') },
      state: 'rest',
      poll: stopped(),
      now: NIGHT_OVER,
    })
    expect(html).not.toContain('data-test-face')
    expect(html).toContain('data-test-open')
  })

  it('an S5 page keeps its face, which tells the night that just ended', () => {
    const html = tonight({
      initial: { games: stopped(), upcoming: null, now: NIGHT_OVER },
      state: 'after',
      poll: stopped(),
      now: NIGHT_OVER + 60,
    })
    expect(html).toContain('data-test-face')
    expect(html).toContain('data-test-foot')
    expect(html).not.toContain('data-test-open')
  })

  it("the first frame keeps the server's face: hydration matches the server's HTML", () => {
    // No answer yet and the clock still the server's (useNow is 0 while hydrating).
    const html = tonight({ initial: S2_FIRST, state: 'later' })
    expect(html).toContain('data-test-face')
    expect(html).toContain('data-test-foot')
    expect(html).not.toContain('data-test-open')
  })

  it('TonightBoard latches the drop (lib/use-latch.ts); / tells it the state its faces are for', () => {
    const src = read('components', 'tonight-board.tsx')
    expect(src).toMatch(/const gone = useLatch\(faceGone\(state, shown, now\)\)/)
    expect(src).toContain('idleFace={gone ? undefined : idleFace}')
    expect(src).toContain('idleFoot={gone ? undefined : idleFoot}')
    // No second, hand-rolled latch beside it (refix 1's setter went untested).
    expect(src).not.toMatch(/setHeld|swapHeld/)
    expect(read('app', 'page.tsx')).toMatch(/<TonightBoard\s[^>]*\bstate=\{screen\.state\}/)
    // One rule for S3/S4 on the server and the swap in the browser.
    expect(read('lib', 'server', 'first-screen.ts')).toContain('marketOpen(games, now)')
  })
})

// `/games` answers `s-maxage=1, stale-while-revalidate=5` for the edge, and a browser honours the
// stale-while-revalidate too: by default each 3 s tick showed the answer fetched in the background
// one tick earlier, so a market opening reached the board a poll late (measured 3.4-6.0 s after
// the market's row was written, on next start). The board's poll asks the server first.
describe("the board's poll shows the server's newest answer, within one poll (G4)", () => {
  it('asks the server before the browser copy: cache "no-cache" on the same /games request', async () => {
    const seen: Array<[unknown, RequestInit | undefined]> = []
    // The client binds fetch when it is built: stub first, then load the module afresh.
    vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
      seen.push([input, init])
      return new Response(JSON.stringify({ games: [] }), {
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.resetModules()
    const { api, boardApi } = await import('../lib/api')
    try {
      await expect(boardApi.games.list()).resolves.toEqual([])
      await expect(api.games.list()).resolves.toEqual([])
    } finally {
      vi.unstubAllGlobals()
    }
    expect(seen).toHaveLength(2)
    const [board, other] = seen
    // One origin and path for both: the board's client reaches nothing new (R9 connect-src).
    expect(board?.[0]).toBe(other?.[0])
    expect(String(board?.[0])).toMatch(/\/games$/)
    expect(board?.[1]?.cache).toBe('no-cache')
    expect(board?.[1]?.method).toBe('GET')
    // The other pages keep fetch's own default.
    expect(other?.[1]).not.toHaveProperty('cache')
  })

  it('polls the board through that client; the other pages keep theirs', () => {
    const api = read('lib', 'api.ts')
    expect(api).toMatch(/export const boardApi = new HoragonClient\(\{[^}]*cache: 'no-cache'/s)
    const board = read('components', 'tonight-board.tsx')
    expect(board).toContain("usePoll('games', () => boardApi.games.list())")
    expect(board).not.toMatch(/\bapi\.games\.list\(\)/)
  })
})

describe('/ hands the board both faces, so the swap needs no reload (§3, §7)', () => {
  const page = read('app', 'page.tsx')

  it('passes the compact story and the Practice line as the open foot', () => {
    const board = page.indexOf('<TonightBoard')
    const open = page.indexOf('openFoot={', board)
    expect(open).toBeGreaterThan(board)
    const compact = page.indexOf('variant="compact"', open)
    expect(compact).toBeGreaterThan(open)
    expect(page.indexOf('<PracticeStrip', compact)).toBeGreaterThan(compact)
    // No second, server-only copy of the S3/S4 layout outside the board.
    expect(page).not.toContain('{!face &&')
    expect(read('components', 'tonight-board.tsx')).toContain('openFoot={openFoot}')
  })
})
