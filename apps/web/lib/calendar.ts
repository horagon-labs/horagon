// The calendar file of one game day (culture plan A3, string 4): app/calendar/[date] answers an
// .ics with one event, from the first market's opening to the last game's close, in UTC. It holds
// the games and the play-money line, and nothing about the person who downloads it. Server only.
import type { Game } from '@horagon/sdk'
import { PLAY_MONEY_NOTICE } from '@horagon/sdk/notice'
import { etClock, etDay, etDayLabel } from './chrono/time'
import { gameInterval } from './chrono/tracks'

const DATE = /^\d{4}-\d{2}-\d{2}$/
/** RFC 5545 3.1: a content line is at most 75 octets, then folded. */
const LINE_OCTETS = 75

/** A real calendar date in YYYY-MM-DD. */
export function isCalendarDate(date: string): boolean {
  if (!DATE.test(date)) return false
  const t = Date.parse(`${date}T12:00:00Z`)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === date
}

/** "20261127T230000Z": a UTC DATE-TIME. */
const utc = (secs: number): string =>
  `${new Date(secs * 1000).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`

/** RFC 5545 3.3.11: a TEXT value, with its backslashes, separators and line breaks escaped. */
const text = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')

/** Folds one content line at 75 octets (RFC 5545 3.1), never inside a UTF-8 character. */
export function icsFold(line: string): string {
  const enc = new TextEncoder()
  const parts: string[] = []
  let part = ''
  let size = 0
  for (const ch of line) {
    const n = enc.encode(ch).length
    // A continuation line starts with one space, which counts toward its 75 octets.
    const room = parts.length === 0 ? LINE_OCTETS : LINE_OCTETS - 1
    if (size + n > room) {
      parts.push(part)
      part = ''
      size = 0
    }
    part += ch
    size += n
  }
  parts.push(part)
  return parts.join('\r\n ')
}

const tipOf = (g: Pick<Game, 'scheduledTipoff'>): number =>
  Math.floor(Date.parse(g.scheduledTipoff) / 1000)

/**
 * The .ics of ET game day `date`: one VEVENT from the first market's opening (tip-off - 60 min)
 * to the latest close (end_ts, or tip-off + 3 h without a market). NBA games only, never a
 * postponed or canceled one. Null when the day has none.
 */
export function nightCalendar(date: string, games: readonly Game[], now: number): string | null {
  const day = games
    .filter(
      (g) =>
        g.league !== 'PRACTICE' &&
        g.status !== 'postponed' &&
        g.status !== 'canceled' &&
        etDay(tipOf(g)) === date,
    )
    .sort((a, b) => tipOf(a) - tipOf(b))
  const first = day[0]
  if (!first) return null
  const spans = day.map((g) =>
    gameInterval(
      g,
      g.markets.find((m) => m.kind === 'winner'),
    ),
  )
  const start = Math.min(...spans.map((s) => s.start))
  const end = Math.max(...spans.map((s) => s.end))
  const count = day.length === 1 ? '1 NBA game' : `${day.length} NBA games`
  const list = day.map((g) => `${g.away} @ ${g.home} · ${etClock(tipOf(g))}`).join('\n')
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Horagon//Game day//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:night-${date}@horagon`,
    `DTSTAMP:${utc(now)}`,
    `DTSTART:${utc(start)}`,
    `DTEND:${utc(end)}`,
    `SUMMARY:${text(`Horagon · ${etDayLabel(tipOf(first))} · ${count}`)}`,
    `DESCRIPTION:${text(`${list}\n\n${PLAY_MONEY_NOTICE}`)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return `${lines.map(icsFold).join('\r\n')}\r\n`
}

/**
 * The route's answer for `date`: the .ics, 404 for a malformed date or a day with no NBA game,
 * 503 when the games could not be read (`load` gives undefined).
 */
export async function calendarResponse(
  date: string,
  load: (date: string) => Promise<readonly Game[] | undefined>,
  now: number,
): Promise<Response> {
  const plain = (status: number, body: string) =>
    new Response(body, {
      status,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  if (!isCalendarDate(date)) return plain(404, 'No such game day.')
  const games = await load(date)
  if (games === undefined) return plain(503, 'The games could not be read. Try again soon.')
  const ics = nightCalendar(date, games, now)
  if (ics === null) return plain(404, 'No NBA games on this day.')
  return new Response(ics, {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="horagon-${date}.ics"`,
      'cache-control': 'public, max-age=300',
    },
  })
}
