// The calendar file of one ET game day (culture plan A3): /calendar/2026-11-27 answers an .ics
// with one event for the night's games (lib/calendar.ts), read in process through the API.
// force-dynamic: nothing here runs at build time, so the build opens no DB or RPC connection.
import { calendarResponse } from '../../../lib/calendar'
import { gamesOn } from '../../../lib/server/api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ date: string }> },
): Promise<Response> {
  const { date } = await ctx.params
  return calendarResponse(date, gamesOn, Math.floor(Date.now() / 1000))
}
