// "Last night on the dial" (R10, culture A4): which night, which rows in which order, and the
// strip's markup. The client is a stub: no API, no DB, no RPC.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Game } from '@horagon/sdk'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LastNightStrip } from '../components/last-night'
import { at, game, market } from '../lib/chrono/fixtures'
import type { BoardClient } from '../lib/server/initial'
import {
  LAST_NIGHT_DAYS,
  LAST_NIGHT_ROWS,
  lastNightHeader,
  lastNightRowText,
  loadLastNight,
  nightRows,
} from '../lib/server/last-night'

const tip = (iso: string) => new Date(at(iso) * 1000).toISOString()

/** A final kind-0 game: `bps` is the home team's opening price, `price` the last indexed one. */
function final(
  id: string,
  home: [string, number],
  away: [string, number],
  bps: number,
  o: { price?: number | null; period?: number; tipoff?: string; over?: Partial<Game> } = {},
): Game {
  return game({
    id,
    home: home[0],
    homeScore: home[1],
    away: away[0],
    awayScore: away[1],
    status: 'final',
    period: o.period ?? 4,
    clockSecs: null,
    scheduledTipoff: o.tipoff ?? tip('2026-11-26T00:00:00Z'),
    markets: [
      market({
        pubkey: `Mkt${id}`,
        status: 'finalized',
        initialPriceBps: bps,
        price: o.price === undefined ? 0.5 : o.price,
      }),
    ],
    ...o.over,
  })
}

function client(byDate: Record<string, Game[] | Promise<Game[]> | Error>) {
  const list = vi.fn(async (q?: { date?: string }) => {
    const day = byDate[q?.date ?? '']
    if (day instanceof Error) throw day
    return (await day) ?? []
  })
  return { list, c: { games: { list, get: vi.fn() } } as unknown as BoardClient }
}

describe('nightRows: the story order (R10)', () => {
  it('puts upsets first (lowest winner opening first), then overtime, closest, tip-off', () => {
    const rows = nightRows([
      final('nba-1', ['NYK', 110], ['BOS', 90], 6_000, { tipoff: tip('2026-11-26T00:00:00Z') }),
      final('nba-2', ['CHA', 105], ['CHI', 107], 7_400), // CHI from 26%: upset
      final('nba-3', ['MIN', 99], ['LAL', 98], 2_800), // MIN from 28%: upset
      final('nba-4', ['DEN', 120], ['PHX', 118], 5_500, { period: 5 }), // overtime
      final('nba-5', ['MIA', 101], ['ORL', 100], 6_500), // margin 1
      final('nba-6', ['SAS', 100], ['DAL', 99], 6_500, { tipoff: tip('2026-11-25T23:00:00Z') }),
      final('nba-7', ['GSW', 130], ['SAC', 100], 6_000, { tipoff: tip('2026-11-25T23:30:00Z') }),
    ])
    expect(rows.rows.map((r) => r.id)).toEqual([
      'nba-2',
      'nba-3',
      'nba-4',
      'nba-6',
      'nba-5',
      'nba-1',
    ])
    expect(rows.rows).toHaveLength(LAST_NIGHT_ROWS)
    expect(rows.upsets).toBe(2)
    expect(rows.rows[0]).toMatchObject({
      winner: 'CHI',
      loser: 'CHA',
      winScore: 107,
      loseScore: 105,
      openedBps: 2_600,
      upset: true,
    })
  })

  it('drops postponed, canceled, Practice and market-less games', () => {
    const rows = nightRows([
      final('nba-1', ['NYK', 110], ['BOS', 90], 6_000),
      final('nba-2', ['NYK', 0], ['BOS', 0], 6_000, { over: { status: 'postponed' } }),
      final('nba-3', ['NYK', 0], ['BOS', 0], 6_000, { over: { status: 'canceled' } }),
      final('prac-1', ['NYK', 110], ['BOS', 90], 6_000, { over: { league: 'PRACTICE' } }),
      final('nba-4', ['NYK', 110], ['BOS', 90], 6_000, { over: { markets: [] } }),
      final('nba-5', ['NYK', 110], ['BOS', 90], 6_000, {
        over: { markets: [market({ kind: 'second-half', status: 'finalized' })] },
      }),
    ])
    expect(rows.rows.map((r) => r.id)).toEqual(['nba-1'])
  })

  it("reads the closed price on the winner's side, null when nothing was indexed", () => {
    const [away, none] = nightRows([
      final('nba-1', ['CHA', 105], ['CHI', 107], 7_400, { price: 0.19 }),
      final('nba-2', ['NYK', 110], ['BOS', 90], 6_000, { price: null }),
    ]).rows
    expect(away?.closed).toBeCloseTo(0.81, 12)
    expect(none?.closed).toBeNull()
  })
})

// 2026-11-27 10:00 UTC is 05:00 ET: the night is still 11-26, so last night is 11-25.
const FIVE_AM = at('2026-11-27T10:00:00Z')

describe('loadLastNight: which night (R10)', () => {
  it('takes the newest ET date before the night with a final NBA game', async () => {
    const { c, list } = client({
      '2026-11-25': [final('nba-1', ['NYK', 110], ['BOS', 90], 6_000)],
      '2026-11-24': [final('nba-2', ['MIA', 110], ['ORL', 90], 6_000)],
    })
    const night = await loadLastNight(c, FIVE_AM, 200)
    expect(night?.date).toBe('2026-11-25')
    expect(night?.rows.map((r) => r.id)).toEqual(['nba-1'])
    // Six days, asked at once.
    expect(list).toHaveBeenCalledTimes(LAST_NIGHT_DAYS)
    expect(list.mock.calls.map(([q]) => q?.date)).toEqual([
      '2026-11-25',
      '2026-11-24',
      '2026-11-23',
      '2026-11-22',
      '2026-11-21',
      '2026-11-20',
    ])
  })

  it('skips a day with no final NBA game, and stops at six days', async () => {
    const practice = final('prac-1', ['NYK', 1], ['BOS', 0], 6_000, {
      over: { league: 'PRACTICE' },
    })
    const { c } = client({
      '2026-11-25': [practice],
      '2026-11-23': [final('nba-1', ['NYK', 110], ['BOS', 90], 6_000)],
    })
    expect((await loadLastNight(c, FIVE_AM, 200))?.date).toBe('2026-11-23')
    const old = client({ '2026-11-19': [final('nba-1', ['NYK', 110], ['BOS', 90], 6_000)] })
    expect(await loadLastNight(old.c, FIVE_AM, 200)).toBeNull()
  })

  it('rolls over at 06:00 ET', async () => {
    const { c } = client({
      '2026-11-25': [final('nba-1', ['NYK', 110], ['BOS', 90], 6_000)],
      '2026-11-26': [final('nba-2', ['MIA', 110], ['ORL', 90], 6_000)],
    })
    // 05:59 ET on 11-27: still the night of 11-26, so last night is 11-25.
    expect((await loadLastNight(c, at('2026-11-27T10:59:00Z'), 200))?.date).toBe('2026-11-25')
    expect((await loadLastNight(c, at('2026-11-27T11:00:00Z'), 200))?.date).toBe('2026-11-26')
  })

  it('is null when there is no night, no kind-0 market, a failure or a late answer', async () => {
    expect(await loadLastNight(client({}).c, FIVE_AM, 200)).toBeNull()
    const bare = final('nba-1', ['NYK', 110], ['BOS', 90], 6_000, { over: { markets: [] } })
    expect(await loadLastNight(client({ '2026-11-25': [bare] }).c, FIVE_AM, 200)).toBeNull()
    const down = client({ '2026-11-25': new Error('down') })
    expect(await loadLastNight(down.c, FIVE_AM, 200)).toBeNull()
    // A late newer day stops the search: an older day never passes for last night.
    const late = client({
      '2026-11-25': new Promise<Game[]>(() => {}),
      '2026-11-24': [final('nba-1', ['NYK', 110], ['BOS', 90], 6_000)],
    })
    expect(await loadLastNight(late.c, FIVE_AM, 20)).toBeNull()
  })
})

// Thu, Nov 26, 10:00 AM ET: Wednesday is the ET calendar day before (first-screen spec C9).
const THU = at('2026-11-26T15:00:00Z')

describe('the strip copy (R10)', () => {
  it('counts the upsets in the header', () => {
    const base = { date: '2026-11-25', rows: [] }
    expect(lastNightHeader({ ...base, upsets: 2 }, THU)).toBe('Last night · Wed, Nov 25 · 2 upsets')
    expect(lastNightHeader({ ...base, upsets: 1 }, THU)).toBe('Last night · Wed, Nov 25 · 1 upset')
    expect(lastNightHeader({ ...base, upsets: 0 }, THU)).toBe(
      'Last night · Wed, Nov 25 · no upsets',
    )
  })

  it('writes a row as the winner, the score, opened and closed (closed once it moved, C14)', () => {
    const [row, bare] = nightRows([
      final('nba-1', ['CHA', 105], ['CHI', 107], 7_400, { price: 0.19 }),
      final('nba-2', ['NYK', 110], ['BOS', 90], 6_000, { price: null }),
    ]).rows
    if (!row || !bare) throw new Error('rows')
    expect(lastNightRowText(row)).toBe('CHI 107–105 CHA · opened 26% · closed 81%')
    expect(lastNightRowText(bare)).toBe('NYK 110–90 BOS · opened 60%')
  })
})

describe('the strip markup (R10)', () => {
  const WEB = join(import.meta.dirname, '..')
  const read = (...p: string[]) => readFileSync(join(WEB, ...p), 'utf8')
  const { rows, upsets } = nightRows([
    final('nba-1', ['CHA', 105], ['CHI', 107], 7_400, { price: 0.19 }),
    final('nba-2', ['NYK', 110], ['BOS', 90], 6_000, { price: null }),
  ])
  const html = renderToStaticMarkup(
    <LastNightStrip night={{ date: '2026-11-25', rows, upsets }} now={THU} />,
  )
  const text = html.replace(/<[^>]+>/g, '')

  it('shows the header, the UPSET plate and the rows, closed omitted when null', () => {
    expect(html).toContain('Last night · Wed, Nov 25 · 1 upset')
    expect(html.match(/>UPSET</g)).toHaveLength(1)
    expect(text).toContain('CHI 107–105 CHA · opened 26% · closed 81%')
    expect(text).toContain('NYK 110–90 BOS · opened 60%')
    expect(text).not.toContain('NYK 110–90 BOS · opened 60% · closed')
    expect(html.match(/<li/g)).toHaveLength(2)
    expect(html).toMatch(/<a [^>]*href="\/study"[^>]*>How the model is checked<\/a>/)
  })

  it('is mono, uses no live colour, and ships no script', () => {
    expect(html).toContain('font-mono')
    expect(html).not.toMatch(/\blive\b/)
    expect(read('components', 'last-night.tsx')).not.toContain("'use client'")
  })

  it('renders on / from the server: the idle face without a story, else under the board', () => {
    // First-screen slice 4: the story card is the idle face and its A4 rows come from /nights;
    // the strip stands in as the face when the story is missing, and follows the board in S3/S4.
    const page = read('app', 'page.tsx')
    const board = page.indexOf('<TonightBoard')
    const face = page.indexOf('<LastNightStrip')
    const under = page.indexOf('<LastNightStrip', board)
    expect(face).toBeGreaterThan(0)
    expect(face).toBeLessThan(board)
    expect(under).toBeGreaterThan(board)
    expect(page.indexOf('<AgentNote />')).toBeGreaterThan(under)
    expect(read('lib', 'server', 'api.ts')).toMatch(/export function initialLastNight\(\)/)
  })
})

describe('the dev gallery (R10)', () => {
  it('draws the strip from a fixture night, outside the client gallery', () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', 'app', 'dev', 'chrono', 'page.tsx'),
      'utf8',
    )
    expect(src).toContain('<LastNightStrip')
    expect(src).toContain('data-dev-last-night')
  })
})
