// A3 (culture plan, rides with R7): the calendar file of the next game day (string 4).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Game } from '@horagon/sdk'
import { PLAY_MONEY_NOTICE } from '@horagon/sdk/notice'
import { describe, expect, it, vi } from 'vitest'
import { calendarResponse, icsFold, nightCalendar } from '../lib/calendar'
import { at, game, market } from '../lib/chrono/fixtures'

const WEB = join(import.meta.dirname, '..')

// Thu, Nov 26, 4:00 AM ET.
const REST_NOW = at('2026-11-26T09:00:00Z')

const scheduled = (iso: string, over: Partial<Game> = {}) =>
  game({ status: 'scheduled', scheduledTipoff: iso, markets: [], ...over })

describe('the calendar file (app/calendar/[date])', () => {
  const games = (): Game[] => [
    game({
      id: 'nba-2',
      status: 'scheduled',
      home: 'BOS',
      away: 'NYK',
      scheduledTipoff: '2026-11-28T02:30:00.000Z',
      markets: [],
    }),
    game({
      id: 'nba-1',
      status: 'scheduled',
      home: 'MEM',
      away: 'LAC',
      scheduledTipoff: '2026-11-28T00:00:00.000Z',
      markets: [market({ endTs: at('2026-11-28T03:10:00Z') })],
    }),
    scheduled('2026-11-28T01:00:00.000Z', { id: 'prac-1', league: 'PRACTICE' }),
    scheduled('2026-11-28T01:00:00.000Z', { id: 'nba-3', status: 'postponed' }),
    scheduled('2026-11-29T00:00:00.000Z', { id: 'nba-4' }),
  ]
  const unfold = (ics: string) => ics.replace(/\r\n /g, '')

  it('holds one event from the first market opening to the last close, in UTC', () => {
    const ics = nightCalendar('2026-11-27', games(), REST_NOW)
    expect(ics).not.toBeNull()
    const text = ics as string
    expect(text.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true)
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(text.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true)
    expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1)
    // The first market opens 60 min before the 7:00 PM ET tip-off.
    expect(text).toContain('\r\nDTSTART:20261127T230000Z\r\n')
    // The later of the market's end_ts and the 9:30 PM game's estimated close (tip + 3 h).
    expect(text).toContain('\r\nDTEND:20261128T053000Z\r\n')
    expect(text).toContain('\r\nDTSTAMP:20261126T090000Z\r\n')
    expect(text).toContain('\r\nUID:night-2026-11-27@horagon\r\n')
    expect(unfold(text)).toContain('SUMMARY:Horagon · Fri\\, Nov 27 · 2 NBA games')
  })

  it('lists the games and carries the legal line verbatim, and nothing personal', () => {
    const text = unfold(nightCalendar('2026-11-27', games(), REST_NOW) as string)
    expect(text).toContain(
      `DESCRIPTION:LAC @ MEM · 7:00 PM ET\\nNYK @ BOS · 9:30 PM ET\\n\\n${PLAY_MONEY_NOTICE}`,
    )
    expect(PLAY_MONEY_NOTICE).toBe('Play-money on devnet. No real value. No prizes.')
    expect(text).not.toMatch(/ORGANIZER|ATTENDEE|wallet/i)
  })

  it('folds lines at 75 octets', () => {
    const long = `DESCRIPTION:${'· '.repeat(60)}`
    const folded = icsFold(long)
    for (const line of folded.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }
    expect(folded.replace(/\r\n /g, '')).toBe(long)
    const ics = nightCalendar('2026-11-27', games(), REST_NOW) as string
    for (const line of ics.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75)
    }
  })

  it('has no file for a day with no NBA game', () => {
    expect(nightCalendar('2026-11-26', games(), REST_NOW)).toBeNull()
    expect(nightCalendar('2026-11-27', [], REST_NOW)).toBeNull()
  })

  it('answers text/calendar, 404 for a bad date or no games, 503 when the API is down', async () => {
    const load = vi.fn(async () => games())
    const ok = await calendarResponse('2026-11-27', load, REST_NOW)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
    expect(ok.headers.get('content-disposition')).toBe(
      'attachment; filename="horagon-2026-11-27.ics"',
    )
    expect(await ok.text()).toContain('BEGIN:VEVENT')
    expect(load).toHaveBeenCalledWith('2026-11-27')

    load.mockClear()
    for (const bad of ['2026-13-01', 'tomorrow', '2026-11-27x']) {
      expect((await calendarResponse(bad, load, REST_NOW)).status).toBe(404)
    }
    expect(load).not.toHaveBeenCalled()
    expect((await calendarResponse('2026-11-26', load, REST_NOW)).status).toBe(404)
    expect((await calendarResponse('2026-11-27', async () => undefined, REST_NOW)).status).toBe(503)
  })

  it('is served by the route, through the server client', () => {
    const src = readFileSync(join(WEB, 'app', 'calendar', '[date]', 'route.ts'), 'utf8')
    expect(src).toContain('export async function GET')
    expect(src).toContain('calendarResponse(')
  })
})
