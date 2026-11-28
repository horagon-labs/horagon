// First screen, slice 5 review finding 2 (first-screen spec §3 S5, §5 C9): the server builds the
// page for the state and the ET night it saw, and the board only re-checks the idle face on its
// poll. A face built for S5 told the night that just ended for as long as the tab stayed open: a
// page loaded at 00:40 ET read "Tonight on the dial · Fri, Nov 27" over "Tonight · Sat Nov 28"
// the next morning, and over Saturday's "All stopped." once Saturday's night was over too. The S1
// and S2 faces and the compact story kept the C9 eyebrow worked out at load past the ET date
// change as well. Now the board asks the server for a new frame (router.refresh, once per frame)
// when the night rolls over at 06:00 ET, when the ET date changes at midnight, or when its idle
// face stops fitting; and an S5 face goes at once when a later night is over under it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Game } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TonightBoard } from '../components/tonight-board'
import { WalletProvider } from '../components/wallet'
import { type Frame, faceGone, frameKey, frameStale, TURN_GRACE_SECS } from '../lib/chrono/board'
import { at, game, market } from '../lib/chrono/fixtures'
import { type ScreenState, screenState } from '../lib/server/first-screen'
import type { InitialBoard } from '../lib/server/initial'

// TonightBoard's poll, clock and refresh, for its render tests: the games a tick answered, the
// browser's clock, and each (due, key) the board handed useRefresh, in order. Unset, the board
// shows the server's first frame (no answer, clock 0 while hydrating).
const stub = vi.hoisted(() => ({
  games: undefined as Game[] | undefined,
  now: 0,
  refresh: [] as Array<{ due: boolean; key: string }>,
}))
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
vi.mock('../lib/use-refresh', () => ({
  useRefresh: (due: boolean, key: string) => {
    stub.refresh.push({ due, key })
  },
}))

const WEB = join(import.meta.dirname, '..')
const read = (...p: string[]) => readFileSync(join(WEB, ...p), 'utf8')

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
/** The game is final and its winner market's draft proposed, `end` its end time. */
const ended = (g: Game, pubkey: string, end: string): Game => ({
  ...g,
  status: 'final',
  homeScore: 108,
  awayScore: 101,
  period: 4,
  clockSecs: null,
  markets: [
    market({
      pubkey,
      status: 'proposed',
      outcome: 'yes',
      initialPriceBps: Math.round((g.modelProb ?? 0.5) * 10_000),
      price: 0.97,
      endTs: at(end),
      priceTs: at(end) - 600,
    }),
  ],
})

// Friday, ET 11-27: two games, 7:00 and 7:30 PM ET.
const friday = () => [
  sched('nba-401909326', 'MIA', 'NYK', '2026-11-28T00:00:00.000Z', 0.788),
  sched('nba-401909327', 'MIL', 'DET', '2026-11-28T00:30:00.000Z', 0.917),
]
const fridayOver = () =>
  friday().map((g, i) =>
    ended(
      g,
      `MktFri${i}`.padEnd(43, '1'),
      i === 0 ? '2026-11-28T03:00:00Z' : '2026-11-28T03:30:00Z',
    ),
  )
// Saturday, ET 11-28: two games, 7:00 and 8:30 PM ET.
const saturday = () => [
  sched('nba-401909340', 'MEM', 'CLE', '2026-11-29T00:00:00.000Z', 0.62),
  sched('nba-401909341', 'PHI', 'IND', '2026-11-29T01:30:00.000Z', 0.29),
]
const saturdayOver = () =>
  saturday().map((g, i) =>
    ended(
      g,
      `MktSat${i}`.padEnd(43, '1'),
      i === 0 ? '2026-11-29T03:00:00Z' : '2026-11-29T04:30:00Z',
    ),
  )
// Friday 7:00 PM ET minus 59 min: NYK's market has just opened at the model's chance.
const OPEN_NOW = at('2026-11-27T23:01:00Z')
const fridayOpen = () =>
  friday().map((g, i) =>
    i === 0
      ? {
          ...g,
          markets: [
            market({
              pubkey: 'MktOpen'.padEnd(43, '1'),
              initialPriceBps: 7_880,
              price: 0.788,
              priceTs: OPEN_NOW - 5,
              endTs: at('2026-11-28T03:00:00Z'),
            }),
          ],
        }
      : g,
  )

// The clocks the server rendered at.
/** Friday 3:00 PM ET: S2, Friday's games listed, nothing open. */
const S2_AT = at('2026-11-27T20:00:00Z')
/** Friday 5:58 PM ET: S2, an hour before the first market. */
const S2_LATER = at('2026-11-27T22:58:00Z')
/** Saturday 00:40 ET: S5, Friday's night over, before the 06:00 ET rollover (the judge window). */
const S5_AT = at('2026-11-28T05:40:00Z')
/** Saturday 06:00 ET: the night rolls over to ET 11-28. */
const ROLLOVER = at('2026-11-28T11:00:00Z')
/** Saturday 00:00 ET: the ET date changes; the night is still Friday's. */
const MIDNIGHT = at('2026-11-28T05:00:00Z')
/** Sunday 00:40 ET: Saturday's night over too (a tab asleep all day). */
const SAT_OVER = at('2026-11-29T05:40:00Z')

const f = (state: ScreenState | undefined, at_: number): Frame => ({ state, at: at_ })

describe('the fixtures are the states they name', () => {
  it('S2, S3 and S5 as the server picks them', () => {
    expect(screenState(friday(), S2_AT)).toBe('later')
    expect(screenState(fridayOpen(), OPEN_NOW)).toBe('preopen')
    expect(screenState(fridayOver(), S5_AT)).toBe('after')
    expect(screenState(saturday(), ROLLOVER + 61)).toBe('later')
    expect(screenState(saturdayOver(), SAT_OVER)).toBe('after')
    expect(screenState([], S2_AT)).toBe('rest')
  })
})

describe('faceGone: an S5 face goes once a later night is over under it', () => {
  it('keeps the S5 face over its own night, which it tells', () => {
    expect(faceGone(f('after', S5_AT), fridayOver(), S5_AT + 3_600)).toBe(false)
    expect(faceGone(f('after', S5_AT), fridayOver(), ROLLOVER - 1)).toBe(false)
  })

  it("keeps it past 06:00 ET while the new night's games are still ahead: the refresh replaces it", () => {
    expect(faceGone(f('after', S5_AT), saturday(), ROLLOVER + 61)).toBe(false)
    expect(faceGone(f('after', S5_AT), [...fridayOver(), ...saturday()], ROLLOVER + 61)).toBe(false)
  })

  it("drops it once the next night is over: no Friday face under Saturday's All stopped.", () => {
    expect(faceGone(f('after', S5_AT), saturdayOver(), SAT_OVER)).toBe(true)
    // An S5 face built for Saturday tells Saturday: it fits.
    expect(faceGone(f('after', SAT_OVER - 60), saturdayOver(), SAT_OVER)).toBe(false)
  })

  it('S1 and S2 faces go at the night over, as before, whatever night they were built on', () => {
    expect(faceGone(f('later', S2_AT), fridayOver(), S5_AT)).toBe(true)
    expect(faceGone(f('rest', S2_AT), saturdayOver(), SAT_OVER)).toBe(true)
    expect(faceGone(f('later', S2_AT), friday(), S2_LATER)).toBe(false)
    expect(faceGone(f('later', S2_LATER), fridayOpen(), OPEN_NOW)).toBe(true)
  })
})

describe('frameStale: the server frame no longer fits, so the board asks for a new one', () => {
  it("never on the first frame: the server's games at the server's clock", () => {
    expect(frameStale(f('rest', S2_AT), true, [], S2_AT)).toBe(false)
    expect(frameStale(f('later', S2_AT), true, friday(), S2_AT)).toBe(false)
    expect(frameStale(f('after', S5_AT), true, fridayOver(), S5_AT)).toBe(false)
    expect(frameStale(f('preopen', OPEN_NOW), false, fridayOpen(), OPEN_NOW)).toBe(false)
    expect(frameStale(f('later', S2_AT), true, undefined, S2_AT)).toBe(false)
  })

  it('at the 06:00 ET rollover, once the grace has passed, with or without a face', () => {
    expect(TURN_GRACE_SECS).toBe(60)
    const s5 = f('after', S5_AT)
    expect(frameStale(s5, true, fridayOver(), ROLLOVER - 1)).toBe(false)
    expect(frameStale(s5, true, saturday(), ROLLOVER + TURN_GRACE_SECS - 1)).toBe(false)
    expect(frameStale(s5, true, saturday(), ROLLOVER + TURN_GRACE_SECS)).toBe(true)
    // Hours later (a tab hidden all morning).
    expect(frameStale(s5, true, saturday(), ROLLOVER + 5 * 3_600)).toBe(true)
    // An S3/S4 page has no face, but its compact story's eyebrow goes stale all the same.
    expect(frameStale(f('live', S5_AT - 7_200), false, saturday(), ROLLOVER + 61)).toBe(true)
  })

  it('at the ET date change (C9 "Last night on the dial" names the day before today)', () => {
    const s1 = f('rest', S2_AT)
    expect(frameStale(s1, true, [], MIDNIGHT + TURN_GRACE_SECS - 1)).toBe(false)
    expect(frameStale(s1, true, [], MIDNIGHT + TURN_GRACE_SECS)).toBe(true)
    expect(frameStale(f('live', at('2026-11-28T03:00:00Z')), false, [], MIDNIGHT + 60)).toBe(true)
  })

  it('not for a frame the server rendered just after the turn, though the grace reads back', () => {
    expect(frameStale(f('later', ROLLOVER + 30), true, saturday(), ROLLOVER + 31)).toBe(false)
    expect(frameStale(f('after', MIDNIGHT + 20), true, fridayOver(), MIDNIGHT + 21)).toBe(false)
  })

  it('when its idle face goes, but only if the server gave one', () => {
    // An S2 face, then the first market opens: the server would lay out S3.
    expect(frameStale(f('later', S2_LATER), true, fridayOpen(), OPEN_NOW)).toBe(true)
    // An S3 page: a market trades from its first frame, and there is no face to fit.
    expect(frameStale(f('preopen', OPEN_NOW), false, fridayOpen(), OPEN_NOW + 30)).toBe(false)
    // An S5 face asleep through the next night.
    expect(frameStale(f('after', S5_AT), true, saturdayOver(), SAT_OVER)).toBe(true)
  })
})

describe('frameKey: one key per state, ET night and ET date', () => {
  it('is the same for any render of the same frame, and new for a new one', () => {
    expect(frameKey(f('after', S5_AT))).toBe('after:2026-11-27:2026-11-28')
    // The server's clock a few seconds behind the browser's: the same frame comes back.
    expect(frameKey(f('after', ROLLOVER - 2))).toBe('after:2026-11-27:2026-11-28')
    expect(frameKey(f('later', ROLLOVER + 3))).toBe('later:2026-11-28:2026-11-28')
    expect(frameKey(f('after', ROLLOVER))).toBe('after:2026-11-28:2026-11-28')
    expect(frameKey(f('after', MIDNIGHT - 1))).toBe('after:2026-11-27:2026-11-27')
    expect(frameKey(f('later', S2_AT))).toBe('later:2026-11-27:2026-11-27')
  })
})

describe('TonightBoard asks for a new frame when its own stops fitting', () => {
  // One render of the board with what the poll answered, as the browser renders it after a tick;
  // web tests have no DOM, so the refresh itself is lib/use-refresh.ts's (test/use-refresh.test.ts).
  const tonight = (p: {
    initial: InitialBoard
    state?: ScreenState
    poll?: Game[]
    now?: number
    faces?: boolean
  }) => {
    stub.games = p.poll
    stub.now = p.now ?? 0
    stub.refresh = []
    const faces = p.faces ?? true
    try {
      const html = renderToStaticMarkup(
        <WalletProvider>
          <TonightBoard
            initial={p.initial}
            state={p.state}
            idleFace={faces ? <p data-test-face>FACE</p> : undefined}
            idleFoot={faces ? <p data-test-foot>FOOT</p> : undefined}
            openFoot={<p data-test-open>COMPACT</p>}
          />
        </WalletProvider>,
      )
      return { html, refresh: stub.refresh.at(-1) }
    } finally {
      stub.games = undefined
      stub.now = 0
    }
  }
  const S5_FIRST: InitialBoard = { games: fridayOver(), upcoming: null, now: S5_AT }

  it('an S5 page past 06:00 ET keeps its face until the new frame lands, and asks for it', () => {
    const before = tonight({
      initial: S5_FIRST,
      state: 'after',
      poll: saturday(),
      now: ROLLOVER + 30,
    })
    expect(before.refresh).toEqual({ due: false, key: 'after:2026-11-27:2026-11-28' })
    const after = tonight({
      initial: S5_FIRST,
      state: 'after',
      poll: saturday(),
      now: ROLLOVER + 61,
    })
    expect(after.refresh).toEqual({ due: true, key: 'after:2026-11-27:2026-11-28' })
    expect(after.html).toContain('data-test-face')
    expect(after.html).not.toContain('data-test-open')
  })

  it("an S5 page asleep through the next night drops its face under Saturday's All stopped.", () => {
    const { html, refresh } = tonight({
      initial: S5_FIRST,
      state: 'after',
      poll: saturdayOver(),
      now: SAT_OVER,
    })
    expect(html).toMatch(/<p [^>]*data-stopped[^>]*>All stopped\.<\/p>/)
    expect(html).not.toContain('data-test-face')
    expect(html).not.toContain('data-test-foot')
    expect(html).toContain('<div data-open-foot="true"><p data-test-open="true">COMPACT</p></div>')
    expect(refresh).toEqual({ due: true, key: 'after:2026-11-27:2026-11-28' })
  })

  it('the new frame lands: its face shows, under a new key, and nothing more is asked', () => {
    const { html, refresh } = tonight({
      initial: { games: saturday(), upcoming: null, now: ROLLOVER + 62 },
      state: 'later',
      poll: saturday(),
      now: ROLLOVER + 63,
    })
    expect(html).toContain('data-test-face')
    expect(refresh).toEqual({ due: false, key: 'later:2026-11-28:2026-11-28' })
  })

  it('a refresh that brings the same frame back keeps its key, so it is not asked again', () => {
    // The server's clock behind the browser's: it renders S5 again at 05:59:58 ET.
    const again = tonight({
      initial: { games: fridayOver(), upcoming: null, now: ROLLOVER - 2 },
      state: 'after',
      poll: saturday(),
      now: ROLLOVER + 61,
    })
    expect(again.refresh).toEqual({ due: true, key: 'after:2026-11-27:2026-11-28' })
  })

  it("asks nothing on the first frame: the server's games and clock (hydration)", () => {
    const firsts: Array<[InitialBoard, ScreenState]> = [
      [S5_FIRST, 'after'],
      [{ games: friday(), upcoming: null, now: S2_AT }, 'later'],
      [{ games: [], upcoming: null, now: S2_AT }, 'rest'],
    ]
    for (const [initial, state] of firsts) {
      const { html, refresh } = tonight({ initial, state })
      expect(refresh?.due, state).toBe(false)
      expect(html, state).toContain('data-test-face')
    }
    const s3 = tonight({
      initial: { games: fridayOpen(), upcoming: null, now: OPEN_NOW },
      state: 'preopen',
      faces: false,
    })
    expect(s3.refresh?.due).toBe(false)
  })

  it('an S3 page asks nothing while its market trades; an S2 page asks once its face goes', () => {
    const s3 = tonight({
      initial: { games: fridayOpen(), upcoming: null, now: OPEN_NOW },
      state: 'preopen',
      poll: fridayOpen(),
      now: OPEN_NOW + 30,
      faces: false,
    })
    expect(s3.refresh?.due).toBe(false)
    const s2 = tonight({
      initial: { games: friday(), upcoming: null, now: S2_LATER },
      state: 'later',
      poll: fridayOpen(),
      now: OPEN_NOW,
    })
    expect(s2.html).not.toContain('data-test-face')
    expect(s2.refresh).toEqual({ due: true, key: 'later:2026-11-27:2026-11-27' })
  })

  it('an S1 page asks at the ET date change, its eyebrow worked out the day before', () => {
    const s1 = (now: number) =>
      tonight({ initial: { games: [], upcoming: null, now: S2_AT }, state: 'rest', poll: [], now })
    expect(s1(MIDNIGHT + 59).refresh?.due).toBe(false)
    expect(s1(MIDNIGHT + 60).refresh).toEqual({ due: true, key: 'rest:2026-11-27:2026-11-27' })
  })

  it('TonightBoard keys the latch and the refresh on the frame; the refresh is the router', () => {
    const board = read('components', 'tonight-board.tsx')
    expect(board).toContain('const frame = { state, at: initial.now }')
    expect(board).toContain('const key = frameKey(frame)')
    expect(board).toContain('const gone = useLatch(faceGone(frame, shown, now), key)')
    expect(board).toContain('useRefresh(frameStale(frame, idleFace != null, shown, now), key)')
    const hook = read('lib', 'use-refresh.ts')
    expect(hook).toContain("import { useRouter } from 'next/navigation'")
    expect(hook).toContain('router.refresh()')
    expect(hook).not.toMatch(/location\.|reload\(/)
  })
})
