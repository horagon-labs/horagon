// The board's rows (spec 4.1): one per game, built from the winner market (the UI shows no
// second-half market), the wallet's positions and the shared clock.
import type { Game, MarketSummary, PositionsResponse } from '@horagon/sdk'
import { formatAmount, parseAmount } from '@horagon/sdk/amount'
import { etNight } from '@horagon/sdk/et'
import { effectiveTime } from '@horagon/sdk/math'
import { isTonight, percent, usdc } from '../format'
import { rowSubject, started } from './copy'
import { timeLeftFraction } from './geometry'
import {
  type DialState,
  deriveDialState,
  dialLabel,
  isTrading,
  needlePrice,
  secsToClose,
  stillTrades,
} from './state'
import { etClock, etDay, etDayLabel, etWeekday } from './time'
import { gameInterval, type Interval } from './tracks'

export interface BoardItem {
  id: string
  game: Game
  market: MarketSummary | undefined
  state: DialState
  /** The home side's price for the needle; null for no needle. */
  price: number | null
  /** Share of the market's life still ahead, 0-1. */
  timeLeft: number
  /** It trades now or still will (`stillTrades`): never a game that started with no market. */
  trading: boolean
  /** Seconds of trading left; null without a market. */
  secsLeft: number | null
  /** The wallet holds shares of this game's winner market. */
  held: boolean
  interval: Interval
}

export const winnerOf = (game: Pick<Game, 'markets'>): MarketSummary | undefined =>
  game.markets.find((m) => m.kind === 'winner')

function holds(portfolio: PositionsResponse | undefined, gameId: string): boolean {
  return (portfolio?.positions ?? []).some(
    (p) => p.gameId === gameId && p.kind === 'winner' && parseAmount(p.shares) > 0n,
  )
}

export function boardItem(
  game: Game,
  portfolio: PositionsResponse | undefined,
  now: number,
): BoardItem {
  const market = winnerOf(game)
  const state = deriveDialState(game, market, now)
  const interval = gameInterval(game, market)
  const trading = stillTrades(state, game, market !== undefined)
  return {
    id: game.id,
    game,
    market,
    state,
    price: needlePrice(state, market),
    // MarketSummary has no startTs: tip-off - 60 min stands in for it (spec 4.1). Once trading
    // stopped no time is left (R5c): a close at the final buzzer leaves no ring up to end_ts, and
    // a game that started with no market has none either (R5c refix).
    timeLeft: !trading
      ? 0
      : market
        ? timeLeftFraction(interval.start, market.endTs, effectiveTime(now, market.priceTs ?? 0))
        : 1,
    trading,
    secsLeft: secsToClose(market, now),
    held: holds(portfolio, game.id),
    interval,
  }
}

const AFTER_TRADING: readonly DialState[] = ['closed', 'halted', 'proposed', 'challenged']

/**
 * 0 trading now, 1 not started, 2 waiting for a result (or started with no market, which will
 * not trade), 3 resolved or void.
 */
function group(i: BoardItem): number {
  if (i.state === 'resolved' || i.state === 'void') return 3
  if (AFTER_TRADING.includes(i.state) || !i.trading) return 2
  return i.game.status === 'scheduled' ? 1 : 0
}

/**
 * Spec 4.1: live games first, the soonest close on top; then games not started, by tip-off;
 * results last. Games that stopped trading but wait for a result sit just before the results.
 */
export function listOrder(a: BoardItem, b: BoardItem): number {
  const g = group(a) - group(b)
  if (g !== 0) return g
  if (group(a) === 0) return a.interval.end - b.interval.end
  return a.interval.tip - b.interval.tip
}

/**
 * The YourHour chip (spec 3.2): open positions and what they are worth now. A position stays
 * open while its market has no result, or while it still has something to claim (M16).
 */
export function yourHour(
  portfolio: PositionsResponse | undefined,
): { count: number; value: string } | null {
  if (!portfolio) return null
  const open = portfolio.positions.filter(
    (p) => parseAmount(p.shares) > 0n && (p.outcome === null || p.claimable),
  )
  const value = open.reduce((sum, p) => sum + parseAmount(p.valueUsdc), 0n)
  return { count: open.length, value: usdc(formatAmount(value)) }
}

/**
 * A row's three right-hand lines (R5, audit section 13): whose chance the number is, the number
 * in percent, and the close. "MEM to win · 62% · latest 10:40 PM ET" while it trades (it closes
 * at the final buzzer, end_ts at the latest, R1); once the final buzzer went, "CHA lost · 74% ·
 * result pending"; after the result, "Resolved: MEM won" with no number. A market that stopped
 * names no time. A game that started with no market says so (R5c), never a past opening time.
 */
export function rowWords(i: BoardItem): { subject: string; value: string; note: string } {
  const subject = rowSubject(i.state, i.game, i.market?.outcome ?? null)
  if (i.state === 'resolved') return { subject, value: '', note: 'result final' }
  if (i.state === 'void') return { subject, value: '', note: '' }
  const value = i.price === null ? '—' : percent(i.price)
  if (!i.market && started(i.game)) return { subject, value, note: 'no market' }
  const pending = i.game.status === 'final' || i.state === 'proposed' || i.state === 'challenged'
  if (pending) return { subject, value, note: 'result pending' }
  if (!i.market) return { subject, value, note: `opens ${etClock(i.interval.start)}` }
  const latest = `latest ${etClock(i.interval.end)}`
  if (isTrading(i.state)) return { subject, value, note: latest }
  return { subject, value, note: i.state === 'halted' ? 'trading halted' : 'trading closed' }
}

/** What a screen reader hears for one game, on its row link and in the Night dial's list. */
export function itemLabel(i: BoardItem): string {
  const g = i.game
  const teams =
    g.status === 'scheduled'
      ? `${g.away} at ${g.home}`
      : `${g.away} ${g.awayScore}, ${g.home} ${g.homeScore}`
  const words = dialLabel({
    game: g,
    outcome: i.market?.outcome ?? null,
    price: i.price,
    modelProb: g.modelProb,
    state: i.state,
    secsLeft: i.secsLeft,
  })
  return `${teams}. ${words}${i.held ? '. You hold a position' : ''}`
}

/** The next games after tonight: the first tip-off and how many games share its ET day. */
export interface Upcoming {
  tip: number
  count: number
}

const tipOf = (g: Pick<Game, 'scheduledTipoff'>): number =>
  Math.floor(Date.parse(g.scheduledTipoff) / 1000)

/**
 * The first scheduled games past tonight's window (lib/format.ts `isTonight`), so an empty board
 * can say when the next ones are (R5). Null when `games` holds none.
 */
export function upcomingOf(games: readonly Game[], nowSecs: number): Upcoming | null {
  return aheadOf(
    games.filter((g) => !isTonight(g, nowSecs * 1000)),
    nowSecs,
  )
}

/** The first scheduled tip-off still ahead in `games`, and how many games share its ET date. */
function aheadOf(games: readonly Game[], now: number): Upcoming | null {
  const tips = games
    .filter((g) => g.status === 'scheduled')
    .map(tipOf)
    .filter((t) => t > now)
    .sort((a, b) => a - b)
  const first = tips[0]
  if (first === undefined) return null
  const day = etDay(first)
  return { tip: first, count: tips.filter((t) => etDay(t) === day).length }
}

/** "Next games: Fri, Nov 27 · 4 games from 7:00 PM ET". */
export function nextLine(u: Upcoming): string {
  const games = u.count === 1 ? '1 game' : `${u.count} games`
  return `Next games: ${etDayLabel(u.tip)} · ${games} from ${etClock(u.tip)}`
}

/**
 * "Tonight · Thu Nov 27" (culture string 2): the ET night on the board, which rolls over at
 * 06:00 ET like the API's (etNight), so after midnight it still names the night. CSS uppercases it.
 */
export function boardLabel(now: number): string {
  const noon = Date.parse(`${etNight(now)}T12:00:00Z`) / 1000
  return `Tonight · ${etDayLabel(noon).replace(',', '')}`
}

/**
 * "Next · Fri Nov 27": the board's heading when every game it lists belongs to a later night (an
 * evening with no game of its own, or after midnight once the night's games left the list), so
 * those games are never headed with tonight's date.
 */
export function nextLabel(tip: number): string {
  return `Next · ${etDayLabel(tip).replace(',', '')}`
}

/** The game is on the court, or tips off on the ET night `night` (etNight, 06:00 rollover). */
const ofNight = (g: Game, night: string): boolean =>
  g.status === 'live' || etDay(tipOf(g)) === night

const REST = 'The dial rests tonight.'

/** Whole hours to `tip`, at least 1. */
const hoursTo = (tip: number, now: number): number => Math.max(1, Math.round((tip - now) / 3_600))

/**
 * The rest face's words (culture string 3) on a night with no game: "The dial rests tonight.
 * Next tip-off Fri, Nov 27 · 7:00 PM ET · in 39 h", or the first sentence with none known.
 */
export function restLine(next: Upcoming | null, now: number): string {
  if (!next || next.tip <= now) return REST
  return `${REST} Next tip-off ${etDayLabel(next.tip)} · ${etClock(next.tip)} · in ${hoursTo(next.tip, now)} h`
}

/** Culture string 21: "All stopped. Next tip-off Sat 3:30 PM ET.", or "All stopped.". */
export function stoppedLine(tip: number | null, now: number): string {
  if (tip === null || tip <= now) return 'All stopped.'
  return `All stopped. Next tip-off ${etWeekday(tip)} ${etClock(tip)}.`
}

/** Culture string 4: the next game day's calendar file (app/calendar/[date]), by its ET date. */
export function calendarLink(next: Upcoming): { href: string; label: string } {
  return {
    href: `/calendar/${etDay(next.tip)}`,
    label: `Add ${etWeekday(next.tip, 'long')}'s games to your calendar`,
  }
}

/**
 * The night's games (ET, 06:00 rollover) all stopped trading, and none is on the court: the board
 * says "All stopped", and the server looks ahead for the next tip-off (lib/server/initial.ts).
 */
export function nightOver(games: readonly Game[], now: number): boolean {
  if (games.some((g) => g.status === 'live')) return false
  const night = etNight(now)
  const nightGames = games.filter((g) => etDay(tipOf(g)) === night)
  return nightGames.length > 0 && nightGames.every((g) => !boardItem(g, undefined, now).trading)
}

export interface BoardModel {
  /** Every team playing tonight, for the follow chips. */
  teams: string[]
  /** The rows after the follow filter, in list order. */
  items: BoardItem[]
  /** The line for an empty board, with the words the board already uses; null with rows. */
  empty: string | null
  /** The follow filter left the board empty: it offers "Show all games". */
  filtered: boolean
  /** On an empty board with no follow filter: when the next games are, if known. */
  next: string | null
  /** The Night dial's clock (spec 5.4): `now` moved up to the newest winner `priceTs` the board has seen. */
  chainNow: number
  /** The Night dial's arcs: `items`, or none while the dial rests (no game of the night). */
  dial: BoardItem[]
  /**
   * "Tonight · Thu Nov 27" (boardLabel), or "Next · Fri Nov 27" (nextLabel) when every listed
   * game belongs to a later night.
   */
  label: string
  /** No game of the night (ET, 06:00 rollover): the rest face's words (restLine); else null. */
  rest: string | null
  /** With the rest face: the next game day's calendar file, when the next games are known. */
  calendar: { href: string; label: string } | null
  /** Every game of the night stopped: "All stopped. Next tip-off …" (stoppedLine); else null. */
  stopped: string | null
}

/**
 * Tonight's board (spec 4.1, 4.4): the 24-hour filter, the follow filter and the list order.
 * `upcoming`: the next games the server found past the list's own days (lib/server/initial.ts).
 */
export function boardModel(
  games: Game[] | undefined,
  portfolio: PositionsResponse | undefined,
  now: number,
  follows: readonly string[],
  upcoming: Upcoming | null = null,
): BoardModel {
  const label = boardLabel(now)
  if (games === undefined) {
    return {
      teams: [],
      items: [],
      dial: [],
      empty: 'Loading games…',
      filtered: false,
      next: null,
      chainNow: now,
      label,
      rest: null,
      calendar: null,
      stopped: null,
    }
  }
  // Every endTs comparison on the Night dial uses chain time (spec 5.4), like each row does.
  const newest = Math.max(0, ...games.map((g) => winnerOf(g)?.priceTs ?? 0))
  const chainNow = effectiveTime(now, newest)
  const tonight = games.filter((g) => isTonight(g, now * 1000))
  const teams = [...new Set(tonight.flatMap((g) => [g.away, g.home]))].sort()
  const shown =
    follows.length === 0
      ? tonight
      : tonight.filter((g) => follows.includes(g.home) || follows.includes(g.away))
  const items = shown.map((g) => boardItem(g, portfolio, now)).sort(listOrder)
  const later = upcomingOf(games, now) ?? upcoming
  const ahead = later && later.tip > now ? later : null
  const over = nightOver(games, now)
  // The dial rests on a night with no game of its own (R7 review adv-1, finding 1): the 24 h list
  // may already hold the next night's games, which never make tonight a game night. A night whose
  // games all stopped is over, not at rest, even once they left the 4 h window.
  const night = etNight(now)
  const resting = !games.some((g) => ofNight(g, night)) && !over
  const restNext = resting ? (aheadOf(games, now) ?? ahead) : null
  // Every listed game is of a later night: head the list with that night's date, not tonight's.
  const firstListed = Math.min(...tonight.map(tipOf))
  const laterOnly = tonight.length > 0 && !tonight.some((g) => ofNight(g, night))
  const base = {
    teams,
    items,
    dial: resting ? [] : items,
    chainNow,
    label: laterOnly ? nextLabel(firstListed) : label,
    rest: resting ? restLine(restNext, now) : null,
    calendar: restNext ? calendarLink(restNext) : null,
    stopped: over ? stoppedLine(aheadOf(games, now)?.tip ?? ahead?.tip ?? null, now) : null,
  }
  if (items.length > 0) return { ...base, empty: null, filtered: false, next: null }
  if (follows.length > 0) {
    const empty = 'No games for the teams you follow in the next 24 hours.'
    return { ...base, empty, filtered: true, next: null }
  }
  const next = ahead ? nextLine(ahead) : null
  return { ...base, empty: 'No NBA games in the next 24 hours.', filtered: false, next }
}

/**
 * The follow chips (R5 review finding 6): tonight's teams, then every followed team with no game
 * tonight, so a follow can always be cleared where it is shown.
 */
export function followChips(teams: readonly string[], follows: readonly string[]): string[] {
  const away = follows.filter((t) => !teams.includes(t))
  return [...teams, ...[...new Set(away)].sort()]
}

/** The follow toggle's summary, from every stored follow: "★ Following MEM, TOR". */
export function followSummary(follows: readonly string[], showAll = false): string {
  if (follows.length === 0) return '☆ Follow teams'
  return `★ Following ${follows.join(', ')}${showAll ? ' · all games shown' : ''}`
}
