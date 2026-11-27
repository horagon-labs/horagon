// Practice (R8): a recorded game replayed at 6x as league PRACTICE, never counted. Its words and
// the pure reads behind the plate, the strip on `/`, the Practice card that leads the idle face
// while a run is on (first-screen S6, W8/W8b) and the /practice page. A Practice game is told apart
// by its league only, and every place that shows one says so.
import type { Game, PracticeResponse } from '@horagon/sdk'
import { etClock, inMinutes } from './time'

/** String 26 of the culture plan, word for word. */
export const PRACTICE_LINE = 'Replay · a recorded night · practice calls never count'
export const COUNTERPARTY_NONE =
  'No one else trades this replay. The price moves only when someone calls.'
export const COUNTERPARTY_AGENT =
  'The reference agent (horagon:bot) trades this replay too, toward the model.'
export const PRACTICE_RESULT_HEADING = 'Practice result on-chain'
export const NO_PRACTICE_NEXT = 'No practice game is on the schedule yet.'

/**
 * The recordings the keeper replays (tests/fixtures/replay), by ESPN event id: the ET night each
 * was recorded on. A test checks this list against the folder.
 */
export const PRACTICE_RECORDINGS: Readonly<Record<string, string>> = {
  '401910007': '2026-11-18',
  '401910008': '2026-11-18',
  '401910009': '2026-11-18',
  '401910010': '2026-11-18',
  '401910011': '2026-11-18',
  '401910012': '2026-11-18',
  '401910013': '2026-11-18',
  '401910014': '2026-11-18',
  '401910015': '2026-11-18',
  '401910016': '2026-11-18',
  '401910017': '2026-11-18',
  '401910018': '2026-11-18',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const isPractice = (g: Pick<Game, 'league'>): boolean => g.league === 'PRACTICE'

const matchup = (g: Pick<Game, 'home' | 'away'>) => `${g.away} @ ${g.home}`

/** "Recorded Nov 18 ET · MEM @ CLE"; the run's id is `practice-<ESPN id>p<tag>`. */
export function recordedLine(g: Pick<Game, 'id' | 'home' | 'away'>): string {
  const espn = /^practice-(\d+)p[0-9a-z]+$/.exec(g.id)?.[1]
  const date = espn ? PRACTICE_RECORDINGS[espn] : undefined
  if (!date) return `A recorded game · ${matchup(g)}`
  const [, month, day] = date.split('-').map(Number)
  return `Recorded ${MONTHS[(month ?? 1) - 1]} ${day} ET · ${matchup(g)}`
}

export const counterpartyLine = (c: PracticeResponse['counterparty']): string =>
  c === 'agent' ? COUNTERPARTY_AGENT : COUNTERPARTY_NONE

const nextLine = (at: number, now: number) =>
  `Next practice tip-off ${etClock(at)} · ${inMinutes(at - now)}`

export interface PracticeStripLine {
  text: string
  href: string
}

/** The Practice card's button (first-screen C24): to the run's game page. */
export const PLAY_ALONG = 'Play along'

/** "Practice game live · MEM @ CLE · Replay": the strip's line, and line 1 of the card (R8). */
export const practiceLiveLine = (g: Pick<Game, 'home' | 'away'>): string =>
  `Practice game live · ${matchup(g)} · Replay`

/**
 * The run on the court (first-screen S6): live, or scheduled and past its tip-off, as the strip
 * reads it. Null between runs, after the Final, and with the flag off (`null`).
 */
export function practiceLive(p: PracticeResponse | null, now: number): Game | null {
  const c = p?.current
  if (!c) return null
  if (c.status === 'live') return c
  const tip = Math.floor(Date.parse(c.scheduledTipoff) / 1000)
  return c.status === 'scheduled' && tip <= now ? c : null
}

/**
 * The strip on `/`: the run on the court, else the next tip-off (a run not yet tipped off, then
 * the Practice process's next slot), else nothing. Null too with the flag off (`null`).
 */
export function practiceStrip(p: PracticeResponse | null, now: number): PracticeStripLine | null {
  if (!p) return null
  const c = p.current
  if (c?.status === 'live') return { text: practiceLiveLine(c), href: `/game/${c.id}` }
  if (c?.status === 'scheduled') {
    const tip = Math.floor(Date.parse(c.scheduledTipoff) / 1000)
    if (tip > now) return { text: nextLine(tip, now), href: `/game/${c.id}` }
    return { text: practiceLiveLine(c), href: `/game/${c.id}` }
  }
  if (p.nextAt !== null && p.nextAt > now)
    return { text: nextLine(p.nextAt, now), href: '/practice' }
  return null
}

/** /practice: to the run in flight, else the next tip-off's line. Null with the flag off. */
export function practicePage(
  p: PracticeResponse | null,
  now: number,
): { redirect: string } | { line: string } | null {
  if (!p) return null
  if (p.current) return { redirect: `/game/${p.current.id}` }
  if (p.nextAt !== null && p.nextAt > now) return { line: nextLine(p.nextAt, now) }
  return { line: NO_PRACTICE_NEXT }
}
