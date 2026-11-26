// Titles, descriptions and the share card's words (R5). A shared game link unfurls as
// "LAC @ MEM · MEM to win 62% · Horagon" with the score or the tip-off, and every description
// ends on the play-money line (PLAY_MONEY_NOTICE, the one copy of it).
import { type GameDetail, PLAY_MONEY_NOTICE } from '@horagon/sdk'
import { winnerOf } from './chrono/board'
import { dialCaption, liveNumber, toWin, verdict } from './chrono/copy'
import { gameDial } from './chrono/game'
import { etClock, etDayLabel } from './chrono/time'
import { gameClock } from './format'

export const SITE_NAME = 'Horagon'
export const SITE_TITLE = 'Horagon · Game-day NBA markets'
export const HOME_TITLE = "Horagon · Tonight's NBA games, live"
export const SITE_DESCRIPTION =
  'Call NBA games live on Horagon: prices move with every run and stay open until the final ' +
  `buzzer. ${PLAY_MONEY_NOTICE}`

const LOCAL = 'http://localhost:3000'

/** The site's origin for absolute share links: HORAGON_PUBLIC_URL, or localhost without it. */
export function siteUrl(raw: string | undefined): URL {
  try {
    return new URL(raw || LOCAL)
  } catch {
    return new URL(LOCAL)
  }
}

/** The share card's words and needle for one game. */
export interface GameCard {
  /** "LAC @ MEM". */
  matchup: string
  /** "LAC 54–60 MEM · Q3 4:12", or "Tip-off Tue, Nov 24 · 8:30 PM ET" before the game. */
  line: string
  /** "MEM to win · 62%", "Final · MEM won · result pending", "Resolved: MEM won". */
  headline: string
  /** The home side's price for the needle; null for no needle. */
  price: number | null
  /** The price is still a live chance (lume); after the close it is drawn in ash. */
  live: boolean
}

export function gameCard(g: GameDetail, now: number): GameCard {
  const winner = winnerOf(g)
  const outcome = winner?.outcome ?? null
  const dial = gameDial(g, winner, null, null, now)
  const v = verdict(dial.state, g, outcome)
  const tip = Math.floor(Date.parse(g.scheduledTipoff) / 1000)
  const started = g.status === 'live' || g.status === 'final'
  const line = started
    ? `${g.away} ${g.awayScore}–${g.homeScore} ${g.home} · ${gameClock(g)}`
    : `Tip-off ${etDayLabel(tip)} · ${etClock(tip)}`
  let headline: string
  if (v.kind === 'to-win') headline = toWin(g.home, dial.price)
  else if (v.kind === 'void')
    headline = g.status === 'canceled' ? 'Game canceled' : 'Game postponed'
  else headline = dialCaption(dial.state, g, outcome)
  return {
    matchup: `${g.away} @ ${g.home}`,
    line,
    headline,
    price: dial.price,
    live: liveNumber(dial.state),
  }
}

export interface PageMeta {
  /** The page's own title; the layout's template adds " · Horagon". */
  title: string
  description: string
}

/** A game page's title and description: "LAC @ MEM · MEM to win 62%". */
export function gameMeta(g: GameDetail | undefined, now: number): PageMeta {
  if (!g) return { title: 'NBA game', description: SITE_DESCRIPTION }
  const c = gameCard(g, now)
  const head = c.headline.replace(' to win · ', ' to win ')
  return {
    title: `${c.matchup} · ${head}`,
    description: `${c.headline}. ${c.line}. ${PLAY_MONEY_NOTICE}`,
  }
}

/** The full title as a link unfurls it, where the layout's template does not apply. */
export const fullTitle = (title: string): string => `${title} · ${SITE_NAME}`
