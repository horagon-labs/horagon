import type { Game } from '@horagon/sdk'
import { describe, expect, it } from 'vitest'
import { boardItem, listOrder, winnerOf, yourHour } from '../lib/chrono/board'
import { at, evening, game, market, NOW, portfolio, position } from '../lib/chrono/fixtures'
import { nightAngle } from '../lib/chrono/geometry'
import {
  EST_LENGTH_SECS,
  gameInterval,
  labelIds,
  labelSpots,
  MAX_RINGS,
  nightWindow,
  type Placeable,
  packTracks,
  ringRadius,
  segmentAngles,
  segments,
  type Track,
} from '../lib/chrono/tracks'

const items = (now = NOW) => evening().map((g) => boardItem(g, undefined, now))
const ringsById = (now = NOW) =>
  Object.fromEntries(packTracks(items(now), now).tracks.map((t) => [t.item.id, t.ring]))

describe('gameInterval (spec 3.1)', () => {
  it('runs from tip-off - 60 min to the market’s end_ts', () => {
    const g = game()
    expect(gameInterval(g, market({ endTs: 123_456_789 }))).toEqual({
      start: at('2026-11-25T00:00:00Z'),
      tip: at('2026-11-25T01:00:00Z'),
      end: 123_456_789,
    })
  })

  it('estimates the close as tip-off + 3 h before a market exists, the keeper’s end_ts (R1)', () => {
    const iv = gameInterval(game(), undefined)
    expect(iv.end - iv.tip).toBe(EST_LENGTH_SECS)
    expect(EST_LENGTH_SECS).toBe(10_800)
  })
})

describe('packTracks', () => {
  it('shares a ring between games that do not overlap, sorted by start', () => {
    expect(ringsById()).toEqual({
      'nba-401810003': 0, // BOS @ MIL, closing in 2:10
      'nba-401810001': 1, // MEM @ CLE
      'nba-401810002': 2, // NYK @ ATL
      'nba-401810004': 0, // DEN @ PHX opens after MIL closes
      'nba-401810005': 3, // LAL @ SAC
    })
  })

  it('cuts each track to the window [now - 2 h, now + 10 h]', () => {
    const w = nightWindow(NOW)
    expect(w.to - w.from).toBe(43_200)
    const cle = packTracks(items(), NOW).tracks.find((t) => t.item.id === 'nba-401810001')
    expect(cle?.from).toBe(w.from)
    expect(cle?.to).toBe(NOW + 3_730)
  })

  it('keeps games wholly outside the window out of the dial', () => {
    const early = boardItem(
      game({ id: 'nba-1', scheduledTipoff: '2026-11-24T19:00:00.000Z', markets: [] }),
      undefined,
      NOW,
    )
    const late = boardItem(
      game({ id: 'nba-2', scheduledTipoff: '2026-11-25T13:30:00.000Z', markets: [] }),
      undefined,
      NOW,
    )
    const packed = packTracks([early, late], NOW)
    expect(packed.tracks).toEqual([])
    expect(packed.overflow).toEqual([])
  })

  it('stops at 8 rings and lists the rest as overflow', () => {
    const crowd: Placeable[] = Array.from({ length: 11 }, (_, i) => ({
      id: `g${i}`,
      interval: { start: NOW - 600 + i, tip: NOW + 3_000, end: NOW + 9_000 },
    }))
    const packed = packTracks(crowd, NOW)
    expect(packed.tracks).toHaveLength(MAX_RINGS)
    expect(packed.overflow.map((o) => o.id)).toEqual(['g8', 'g9', 'g10'])
    expect(Math.max(...packed.tracks.map((t) => t.ring))).toBe(7)
  })

  it('lets a game start in the same second the previous one ended', () => {
    const a = { id: 'a', interval: { start: NOW, tip: NOW + 10, end: NOW + 100 } }
    const b = { id: 'b', interval: { start: NOW + 100, tip: NOW + 110, end: NOW + 200 } }
    expect(packTracks([b, a], NOW).tracks.map((t) => [t.item.id, t.ring])).toEqual([
      ['a', 0],
      ['b', 0],
    ])
  })

  it('places rings from the outside in', () => {
    expect(ringRadius(0)).toBe(86)
    expect(ringRadius(7)).toBe(37)
  })
})

describe('segments', () => {
  const trackOf = (id: string) =>
    packTracks(items(), NOW).tracks.find((t) => t.item.id === id) as Track<Placeable>

  it('cuts a live game at tip-off (pre-open, dashed) and at now (past, dim)', () => {
    const w = nightWindow(NOW)
    expect(segments(trackOf('nba-401810001'), NOW)).toEqual([
      { from: w.from, to: at('2026-11-25T01:00:00Z'), pre: true, past: true },
      { from: at('2026-11-25T01:00:00Z'), to: NOW, pre: false, past: true },
      { from: NOW, to: NOW + 3_730, pre: false, past: false },
    ])
  })

  it('leaves a game that has not opened yet whole and ahead of the hand', () => {
    expect(segments(trackOf('nba-401810004'), NOW)).toEqual([
      { from: at('2026-11-25T02:30:00Z'), to: at('2026-11-25T03:30:00Z'), pre: true, past: false },
      { from: at('2026-11-25T03:30:00Z'), to: at('2026-11-25T06:30:00Z'), pre: false, past: false },
    ])
  })

  it('turns times into clockwise angles from the now hand (Review Focus 4)', () => {
    // 9:08 PM ET is 274 degrees; the game that closes at 10:10:10 PM ET ends 31.08 later.
    const a = segmentAngles({ from: NOW, to: NOW + 3_730 }, NOW)
    expect(a.from).toBe(274)
    expect(a.to).toBeCloseTo(305.083, 3)
  })

  it('wraps past midnight ET and across the 2026-11-01 clock change in one turn', () => {
    const now = at('2026-11-01T03:00:00Z') // 11:00 PM EDT
    const late = {
      id: 'late',
      interval: {
        start: at('2026-11-01T03:30:00Z'),
        tip: at('2026-11-01T04:30:00Z'),
        end: at('2026-11-01T06:40:00Z'), // 1:40 AM EST, after the clocks went back
      },
    }
    const [track] = packTracks([late], now).tracks
    const parts = segments(track as Track<Placeable>, now).map((s) => segmentAngles(s, now))
    expect(parts[0]?.from).toBe(345) // 11:30 PM
    expect(parts[0]?.to).toBe(375) // 12:30 AM, past 12 o'clock
    expect(parts[1]?.to).toBe(440) // 3 h 40 min of real time after 11:00 PM
    expect(nightAngle(now + 36_000, now) - nightAngle(now - 7_200, now)).toBe(360)
  })
})

describe('labels (spec 3.1)', () => {
  const packed = packTracks(items(), NOW)

  it('labels the selected, the hovered and the soonest-closing arc, once each', () => {
    const opts = { selectedId: 'nba-401810001', hoverId: null, now: NOW }
    expect(labelIds(packed.tracks, opts)).toEqual(['nba-401810001', 'nba-401810003'])
    expect(labelIds(packed.tracks, { ...opts, selectedId: 'nba-401810003' })).toEqual([
      'nba-401810003',
    ])
    expect(labelIds(packed.tracks, { ...opts, hoverId: 'nba-401810002' })).toEqual([
      'nba-401810001',
      'nba-401810002',
      'nba-401810003',
    ])
  })

  it('never gives the centre to a game that stopped trading while another trades (R1)', () => {
    // BOS @ MIL closes soonest; halted at the final buzzer it reads closed and steps aside.
    const buzzer = evening().map((g) =>
      g.id === 'nba-401810003'
        ? {
            ...g,
            status: 'final' as const,
            markets: g.markets.map((m) => ({ ...m, status: 'halted' as const })),
          }
        : g,
    )
    const stopped = buzzer.map((g) => boardItem(g, undefined, NOW))
    expect(stopped.find((i) => i.id === 'nba-401810003')?.state).toBe('closed')
    const tracks = packTracks(stopped, NOW).tracks
    const opts = { selectedId: null, hoverId: null, now: NOW }
    expect(labelIds(tracks, opts)).toEqual(['nba-401810001'])
    for (const state of [
      'closed',
      'halted',
      'proposed',
      'challenged',
      'resolved',
      'void',
    ] as const) {
      const one = items().map((i) => (i.id === 'nba-401810003' ? { ...i, state } : i))
      expect(labelIds(packTracks(one, NOW).tracks, opts), state).toEqual(['nba-401810001'])
    }
    // The arc itself still runs to end_ts: the summary has no halt time.
    expect(tracks.find((t) => t.item.id === 'nba-401810003')?.to).toBe(NOW + 130)
    // With nothing trading, the soonest end_ts ahead still holds the centre.
    const none = items().map((i) => ({ ...i, state: 'closed' as const }))
    expect(labelIds(packTracks(none, NOW).tracks, opts)).toEqual(['nba-401810003'])
  })

  it('ignores ids that have no arc on the dial', () => {
    expect(labelIds(packed.tracks, { selectedId: 'nba-x', hoverId: null, now: NOW })).toEqual([
      'nba-401810003',
    ])
  })

  it('puts a label inside its arc’s end and drops one that would overlap', () => {
    const [spot] = labelSpots(packed.tracks, ['nba-401810003'], NOW)
    expect(spot?.anchor).toBe('start')
    expect(spot?.x).toBeCloseTo(20.31, 1)
    const twin = (id: string, ring: number): Track<Placeable> => ({
      item: { id, interval: { start: NOW, tip: NOW, end: NOW + 600 } },
      ring,
      from: NOW,
      to: NOW + 600,
    })
    const spots = labelSpots([twin('a', 0), twin('b', 1)], ['a', 'b'], NOW)
    expect(spots.map((s) => s.id)).toEqual(['a'])
  })
})

describe('boardItem', () => {
  it('builds a row from the winner market, the wallet and the clock', () => {
    const item = boardItem(game(), portfolio([position()]), NOW)
    expect(item).toMatchObject({ id: 'nba-401810001', state: 'live', price: 0.77, held: true })
    expect(item.secsLeft).toBe(3_730)
    // Tip-off - 60 min (00:00 UTC) stands in for the market's start (spec 4.1).
    expect(item.timeLeft).toBeCloseTo(3_730 / 11_410, 6)
  })

  it('shows no needle and a full ring before the market opens', () => {
    const phx = evening().find((g) => g.home === 'PHX') as Game
    const item = boardItem(phx, undefined, NOW)
    expect(item).toMatchObject({ state: 'pre', price: null, timeLeft: 1, secsLeft: null })
  })

  it('counts only winner positions with shares as held', () => {
    const none = portfolio([position({ shares: '0' }), position({ kind: 'second-half' })])
    expect(boardItem(game(), none, NOW).held).toBe(false)
    expect(winnerOf({ markets: [market({ kind: 'second-half' })] })).toBeUndefined()
  })
})

describe('listOrder (spec 4.1)', () => {
  it('puts live games first by close, then upcoming by tip-off, then results', () => {
    const resolved = game({
      id: 'nba-r',
      status: 'final',
      scheduledTipoff: '2026-11-24T23:00:00.000Z',
      markets: [market({ status: 'finalized', outcome: 'yes', endTs: NOW - 4_000 })],
    })
    const waiting = game({
      id: 'nba-w',
      status: 'final',
      markets: [market({ endTs: NOW - 60 })],
    })
    const ids = [...evening(), resolved, waiting]
      .map((g) => boardItem(g, undefined, NOW))
      .sort(listOrder)
      .map((i) => i.id)
    expect(ids).toEqual([
      'nba-401810003',
      'nba-401810001',
      'nba-401810002',
      'nba-401810004',
      'nba-401810005',
      'nba-w',
      'nba-r',
    ])
  })
})

describe('yourHour (spec 3.2)', () => {
  it('counts open positions and adds their current value', () => {
    const p = portfolio([
      position(),
      position({ side: 'away', shares: '5', valueUsdc: '2.05' }),
      position({ shares: '0', valueUsdc: '0' }),
    ])
    expect(yourHour(p)).toEqual({ count: 2, value: '12.90' })
  })

  it('is hidden without a wallet, and zero for an empty one', () => {
    expect(yourHour(undefined)).toBeNull()
    expect(yourHour(portfolio([]))).toEqual({ count: 0, value: '0.00' })
  })

  it('stops counting a losing position once there is a result, but keeps one to claim (M16)', () => {
    const result = { marketStatus: 'finalized', outcome: 'no' } as const
    const p = portfolio([
      position({ ...result, valueUsdc: '0' }),
      position({ ...result, side: 'away', shares: '5', valueUsdc: '5', claimable: true }),
      position({ market: 'Mkt2', valueUsdc: '2.5' }),
    ])
    expect(yourHour(p)).toEqual({ count: 2, value: '7.50' })
  })
})
