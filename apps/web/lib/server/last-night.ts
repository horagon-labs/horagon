// "Last night on the dial" (R10, culture A4): the morning after, on /. The newest ET night before
// tonight's with a final NBA game, up to six of its games, the ones with a story first. The
// opening price is the model's pre-game % written on chain; the closing price is the last indexed
// price, which stops at the halt. Pure selection plus a loader; best effort, like the first frame.
import type { Game } from '@horagon/sdk'
import { etNight } from '@horagon/sdk'
import { isUpset, winnerOpened } from '@horagon/sdk/study'
import { percent } from '../format'
import { type BoardClient, INITIAL_TIMEOUT_MS } from './initial'

/** How many ET days before tonight's night the strip looks back. */
export const LAST_NIGHT_DAYS = 6
/** At most this many games in the strip. */
export const LAST_NIGHT_ROWS = 6

export interface LastNightRow {
  id: string
  winner: string
  loser: string
  winScore: number
  loseScore: number
  /** The winner's opening price, in basis points. */
  openedBps: number
  /** The winner's side of the last indexed price (0..1); null when none was indexed. */
  closed: number | null
  upset: boolean
  overtime: boolean
  tipoff: string
}

export interface LastNight {
  /** The ET date (YYYY-MM-DD). */
  date: string
  rows: LastNightRow[]
  /** Upsets among the night's games with a winner market. */
  upsets: number
}

const isFinalNba = (g: Game) => g.status === 'final' && g.league === 'NBA'

function rowOf(g: Game): LastNightRow | null {
  const m = g.markets.find((x) => x.kind === 'winner')
  if (!m || !isFinalNba(g) || g.homeScore === g.awayScore) return null
  const homeWon = g.homeScore > g.awayScore
  return {
    id: g.id,
    winner: homeWon ? g.home : g.away,
    loser: homeWon ? g.away : g.home,
    winScore: Math.max(g.homeScore, g.awayScore),
    loseScore: Math.min(g.homeScore, g.awayScore),
    openedBps: winnerOpened(m.initialPriceBps, homeWon),
    closed: m.price === null ? null : homeWon ? m.price : 1 - m.price,
    upset: isUpset(m.initialPriceBps, homeWon),
    overtime: g.period >= 5,
    tipoff: g.scheduledTipoff,
  }
}

/** Upsets (lowest winner opening first), then overtime, then the closest margin, then tip-off. */
function storyOrder(a: LastNightRow, b: LastNightRow): number {
  if (a.upset !== b.upset) return a.upset ? -1 : 1
  if (a.upset && a.openedBps !== b.openedBps) return a.openedBps - b.openedBps
  if (a.overtime !== b.overtime) return a.overtime ? -1 : 1
  const margin = a.winScore - a.loseScore - (b.winScore - b.loseScore)
  if (margin !== 0) return margin
  return Date.parse(a.tipoff) - Date.parse(b.tipoff)
}

/** The night's final NBA games with a winner market, in story order, at most LAST_NIGHT_ROWS. */
export function nightRows(games: readonly Game[]): { rows: LastNightRow[]; upsets: number } {
  const all = games.map(rowOf).filter((r): r is LastNightRow => r !== null)
  all.sort(storyOrder)
  return { rows: all.slice(0, LAST_NIGHT_ROWS), upsets: all.filter((r) => r.upset).length }
}

const etPrevDay = (date: string) =>
  new Date(Date.parse(`${date}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10)

/**
 * The strip's night, or null: the LAST_NIGHT_DAYS ET days before `etNight(now)` are asked all at
 * once under one `timeoutMs` cap (the shape of `lookAhead`), newest first; the first with a final
 * NBA game is the night. A day that fails or is still out when the cap ends stops the search, so
 * an older night never passes for last night. Null too when that night has no winner market.
 * Never throws.
 */
export async function loadLastNight(
  client: BoardClient,
  nowSecs: number,
  timeoutMs = INITIAL_TIMEOUT_MS,
): Promise<LastNight | null> {
  let date = etNight(nowSecs)
  const days = Array.from({ length: LAST_NIGHT_DAYS }, () => {
    date = etPrevDay(date)
    const asked = date
    return client.games
      .list({ date: asked })
      .then((games) => ({ date: asked, games }))
      .catch(() => undefined)
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), timeoutMs)
  })
  try {
    for (const day of days) {
      const got = await Promise.race([day, late])
      if (got === 'late' || got === undefined) return null
      if (!got.games.some(isFinalNba)) continue
      const { rows, upsets } = nightRows(got.games)
      return rows.length === 0 ? null : { date: got.date, rows, upsets }
    }
    return null
  } finally {
    clearTimeout(timer)
  }
}

const dayLabel = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

/** "Last night on the dial · Wed, Nov 25 · 2 upsets". */
export function lastNightHeader(night: LastNight): string {
  const day = dayLabel.format(new Date(`${night.date}T12:00:00Z`))
  const upsets =
    night.upsets === 0 ? 'no upsets' : `${night.upsets} upset${night.upsets === 1 ? '' : 's'}`
  return `Last night on the dial · ${day} · ${upsets}`
}

/** "CHI 107–105 CHA · opened 26% · closed 81%"; the closed part only when a price was indexed. */
export function lastNightRowText(r: LastNightRow): string {
  const head = `${r.winner} ${r.winScore}–${r.loseScore} ${r.loser} · opened ${percent(r.openedBps / 10_000)}`
  return r.closed === null ? head : `${head} · closed ${percent(r.closed)}`
}
