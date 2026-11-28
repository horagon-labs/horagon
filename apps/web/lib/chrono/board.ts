// The board's rows (spec 4.1): one per game, built from the winner market (the UI shows no
// second-half market), the wallet's positions and the shared clock.
import type { Game, MarketSummary, PositionsResponse } from '@horagon/sdk'
import { formatAmount, parseAmount } from '@horagon/sdk/amount'
import { etNight } from '@horagon/sdk/et'
import { effectiveTime } from '@horagon/sdk/math'
import { countdown, gameClock, isTonight, percent, usdc } from '../format'
import type { ScreenState } from '../server/first-screen'
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
import { etClock, etDay, etDayLabel, etWeekday, inMinutes, roughIn } from './time'
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
 * The move since the market opened, on the subject's (home) side, in points, beside the opening
 * price it moved from (first-screen spec C20, fresh-eyes note 3): "+2 · opened 79%", "−19 ·
 * opened 79%" with U+2212, "+0.4 · opened 79%" under one shown point, and "opening price" while
 * the price still equals the open (to 0.05 of a point). The move is the gap between the two whole
 * % the row shows (the number above it and "opened"), so they add up. No unit word: "pts" on a
 * basketball row reads as the score.
 */
export function sinceOpen(price: number, initialPriceBps: number): string {
  const open = initialPriceBps / 10_000
  const points = (price - open) * 100
  const size = Math.abs(points)
  if (Math.round(price * 10_000) === initialPriceBps || size < 0.05) return 'opening price'
  const whole = Math.round(price * 100) - Math.round(open * 100)
  // Both whole % equal: under one shown point, one decimal, never "1.0" beside the same %.
  const shown =
    whole !== 0 ? String(Math.abs(whole)) : Math.min(0.9, Math.round(size * 10) / 10).toFixed(1)
  return `${points > 0 ? '+' : '−'}${shown} · opened ${percent(open)}`
}

/**
 * A started row's second line, in parts that wrap between, never inside (fresh-eyes note 6): the
 * team ahead first, "MIA 15–11", or "Tied 15–15", then the clock, "Q1 5:22" or "Final". Other
 * states keep the away–home score of the "MIA @ NYK" line above.
 */
export function scoreLine(
  g: Pick<
    Game,
    | 'status'
    | 'away'
    | 'home'
    | 'awayScore'
    | 'homeScore'
    | 'period'
    | 'clockSecs'
    | 'scheduledTipoff'
  >,
): [string, string] {
  const clock = gameClock(g)
  if (g.status !== 'live' && g.status !== 'final') return [`${g.awayScore}–${g.homeScore}`, clock]
  const hi = Math.max(g.awayScore, g.homeScore)
  const lo = Math.min(g.awayScore, g.homeScore)
  const lead = g.awayScore === g.homeScore ? 'Tied' : g.awayScore > g.homeScore ? g.away : g.home
  return [`${lead} ${hi}–${lo}`, clock]
}

/** The indexed price differs from the opening one (spec §6 "moved", board rows). */
export const movedFromOpen = (m: Pick<MarketSummary, 'price' | 'initialPriceBps'>): boolean =>
  m.price !== null && Math.round(m.price * 10_000) !== m.initialPriceBps

export interface RowWords {
  /** Whose chance the number is: "NYK to win", "CLE lost", "MIN won". */
  subject: string
  /** The number in percent, or '' for none. */
  value: string
  /** The number is the model's (no market yet): the row adds " model" (C19). */
  model: boolean
  /** The line under the number. */
  note: string
  /** What the note adds from `sm` up (C20: " · closes by 12:32 AM ET"), or ''. */
  wide: string
}

/**
 * A row's right-hand lines (R5, first-screen spec C19-C21): whose chance the number is, the
 * number in percent, and a note. Before a market opens: "NYK to win · 79% model · opens in 14 h".
 * While it trades: the move since open beside the opening price, "closes by 12:32 AM ET" from
 * `sm` up, and "closes in 2:10" in its last five minutes. Once the final buzzer went, "CHA lost
 * · 74% · result pending"; after the result, "MIN won · opened 28%", plus "closed 81%" only when
 * the price moved. A market that stopped names no time. A game that started with no market says
 * so (R5c).
 */
export function rowWords(i: BoardItem, now: number): RowWords {
  const g = i.game
  const outcome = i.market?.outcome ?? null
  const words = (over: Partial<RowWords>): RowWords => ({
    subject: rowSubject(i.state, g, outcome),
    value: '',
    model: false,
    note: '',
    wide: '',
    ...over,
  })
  if (i.state === 'resolved' && i.market && outcome && g.status === 'final') {
    const homeWon = outcome === 'yes'
    const m = i.market
    const opened = homeWon ? m.initialPriceBps : 10_000 - m.initialPriceBps
    const head = `opened ${percent(opened / 10_000)}`
    const closed = m.price === null ? null : homeWon ? m.price : 1 - m.price
    return words({
      subject: `${homeWon ? g.home : g.away} won`,
      note: closed !== null && movedFromOpen(m) ? `${head} · closed ${percent(closed)}` : head,
    })
  }
  if (i.state === 'resolved') return words({ note: 'result final' })
  if (i.state === 'void') return words({})
  // No market: the model's number, never a dash (C19); none once the game is over.
  const model = i.price === null && g.modelProb !== null && g.status !== 'final'
  const value = i.price !== null ? percent(i.price) : model ? percent(g.modelProb) : ''
  if (!i.market && started(g)) return words({ value, model, note: 'no market' })
  const pending = g.status === 'final' || i.state === 'proposed' || i.state === 'challenged'
  if (pending) return words({ value, note: 'result pending' })
  if (!i.market) return words({ value, model, note: `opens ${roughIn(i.interval.start - now)}` })
  // The last five minutes count down, in the dial's own words (light branding review §10 item 9).
  if (i.state === 'closing')
    return words({ value, note: `closes in ${countdown(i.secsLeft ?? 0, 0)}` })
  if (isTrading(i.state)) {
    const note = i.price === null ? '' : sinceOpen(i.price, i.market.initialPriceBps)
    return words({ value, note, wide: ` · closes by ${etClock(i.interval.end)}` })
  }
  return words({ value, note: i.state === 'halted' ? 'trading halted' : 'trading closed' })
}

/** The market trades now: its number and arc are Live blue (one meaning per colour). */
export const openNow = (i: BoardItem): boolean => i.market !== undefined && isTrading(i.state)

/**
 * Some listed winner market trades now, whatever the follow filter shows (first-screen §3 `open`):
 * how the server picks S3/S4 (lib/server/first-screen.ts), and how the board's poll sees the first
 * open that swaps the idle face for the Night dial (G4).
 */
export const marketOpen = (games: readonly Game[] | undefined, now: number): boolean =>
  (games ?? []).some((g) => isTonight(g, now * 1000) && openNow(boardItem(g, undefined, now)))

/**
 * The server render a page of / shows (first-screen §3): the state it picked
 * (lib/server/first-screen.ts) and the clock it read (InitialBoard.now). It built the idle faces,
 * and every eyebrow and line it wrote, for that state, ET night and ET date.
 */
export interface Frame {
  state: ScreenState | undefined
  /** The server's clock, unix seconds. */
  at: number
}

/**
 * The server's idle face no longer fits what the poll sees (G4), so the board drops it, and keeps
 * it dropped for this frame (components/tonight-board.tsx): a market is open (the Night dial takes
 * the slot), or a night is over that the face does not tell. An S1 or S2 face tells an older
 * night; an S5 face tells the night that just ended, which only the server knows, and only that
 * night: a tab asleep through the next one must not show it under the next one's "All stopped.".
 * A poll that ran all evening drops an S2 face at the first open; one that slept (a hidden tab
 * skips every tick, and no timer runs while the machine sleeps) may first see the night over.
 * Either way the page then shows what an S3/S4-loaded one shows at the night's end, the dial,
 * "All stopped." and the compact story, until the new frame it asks for lands (`frameStale`).
 */
export function faceGone(frame: Frame, games: readonly Game[] | undefined, now: number): boolean {
  if (marketOpen(games, now)) return true
  if (!nightOver(games ?? [], now)) return false
  return frame.state !== 'after' || etNight(frame.at) !== etNight(now)
}

/**
 * How long past 06:00 ET (the night's rollover) and midnight ET (the date's change) the board
 * waits before it asks for a new frame. A browser clock a little ahead of the server's would
 * otherwise ask before the server's clock has turned, get the same frame back, and keep it.
 */
export const TURN_GRACE_SECS = 60

/**
 * The server's frame no longer fits (first-screen §3, C9), so the board asks the server for a new
 * one (router.refresh, lib/use-refresh.ts), once per `frameKey`: the ET night rolled over at
 * 06:00 ET (an S5 face becomes S1 or S2, with the "Last night" or dated eyebrow); the ET date
 * changed at midnight (C9 calls the night "Last night" only on the day after it, the compact
 * story's eyebrow included); or the idle face the server gave (`face`) is gone. Never on the first
 * frame: the server's games at the server's clock fit it.
 */
export function frameStale(
  frame: Frame,
  face: boolean,
  games: readonly Game[] | undefined,
  now: number,
): boolean {
  // Later, not just different: a frame rendered inside the grace already holds the new night.
  const t = now - TURN_GRACE_SECS
  if (etNight(t) > etNight(frame.at) || etDay(t) > etDay(frame.at)) return true
  return face && faceGone(frame, games, now)
}

/**
 * One key per state, ET night and ET date: a refresh that brings the same frame back (a server
 * clock a little behind) keeps the key, so the board asks no more for it.
 */
export const frameKey = (f: Frame): string => `${f.state}:${etNight(f.at)}:${etDay(f.at)}`

/**
 * The H1 may say "Prices move with every run." (first-screen C2b) only when a moved market is on
 * screen. While a listed winner market trades (S3, S4): some listed winner market moved from its
 * open. Otherwise (S1, S2, S5): only the story card's market, `storyMoved`.
 */
export function heroMoved(
  games: readonly Game[] | undefined,
  now: number,
  storyMoved = false,
): boolean {
  const listed = (games ?? [])
    .filter((g) => isTonight(g, now * 1000))
    .map((g) => boardItem(g, undefined, now))
  if (!listed.some(openNow)) return storyMoved
  return listed.some((i) => i.market !== undefined && movedFromOpen(i.market))
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

const gamesCount = (n: number) => (n === 1 ? '1 game' : `${n} games`)
const withCount = (label: string, count?: number) =>
  count ? `${label} · ${gamesCount(count)}` : label

/**
 * "Tonight · Fri Nov 27 · 11 games" (culture string 2, first-screen C16): the ET night on the
 * board, which rolls over at 06:00 ET like the API's (etNight), so after midnight it still names
 * the night; the count only when games are listed. CSS uppercases it.
 */
export function boardLabel(now: number, count?: number): string {
  const noon = Date.parse(`${etNight(now)}T12:00:00Z`) / 1000
  return withCount(`Tonight · ${etDayLabel(noon).replace(',', '')}`, count)
}

/**
 * "Fri Nov 27 · 11 games" (C16): the board's heading when every game it lists belongs to a later
 * night (an evening with no game of its own, or after midnight once the night's games left the
 * list), and the subheading of a later night's games listed under the night's own, so those games
 * are never headed with tonight's date.
 */
export function nextLabel(tip: number, count?: number): string {
  return withCount(etDayLabel(tip).replace(',', ''), count)
}

/** The game is on the court, or tips off on the ET night `night` (etNight, 06:00 rollover). */
const ofNight = (g: Game, night: string): boolean =>
  g.status === 'live' || etDay(tipOf(g)) === night

const NO_GAMES = 'No NBA games in the next 24 hours.'

/**
 * The rest face's words (culture string 3 made date-true, first-screen C22) when the 24 h list is
 * empty: "The dial rests until Fri, Nov 27. 4 games, first tip-off in 39 h.", or "No NBA games in
 * the next 24 hours." with no next games known.
 */
export function restLine(next: Upcoming | null, now: number): string {
  if (!next || next.tip <= now) return NO_GAMES
  const games = next.count === 1 ? '1 game, tip-off' : `${next.count} games, first tip-off`
  return `The dial rests until ${etDayLabel(next.tip)}. ${games} ${roughIn(next.tip - now)}.`
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
  /** The rows under `label`: the night's own games, or every row when all are of a later night. */
  list: BoardItem[]
  /**
   * Rows of a later night in a list that also heads the night's own games (the next slate is
   * often under 24 h away): each night under its own "Sat Nov 28 · 3 games", in list order.
   */
  later: Array<{ label: string; items: BoardItem[] }>
  /** The line for an empty board, with the words the board already uses; null with rows. */
  empty: string | null
  /** The follow filter left the board empty: it offers "Show all games". */
  filtered: boolean
  /** On an empty board with no follow filter: when the next games are, if known. */
  next: string | null
  /** The Night dial's clock (spec 5.4): `now` moved up to the newest winner `priceTs` the board has seen. */
  chainNow: number
  /**
   * The Night dial's arcs: `items` (pre-open ones dotted), or none while the dial rests (the 24 h
   * list is empty).
   */
  dial: BoardItem[]
  /**
   * "Tonight · Fri Nov 27 · 11 games" (boardLabel), or "Fri Nov 27 · 11 games" (nextLabel) when
   * every listed game belongs to a later night.
   */
  label: string
  /** The 24 h list is empty (first-screen S1): the rest face's words (restLine); else null. */
  rest: string | null
  /**
   * The next game day's calendar file: on the rest face, or under a list no market of which has
   * opened yet (first-screen S2, C23); else null.
   */
  calendar: { href: string; label: string } | null
  /** Listed winner markets that trade now: "● 4 markets open now" (C17). */
  openNow: number
  /** No market open yet, and the night not over (S2): "First market opens in 14 h 44 min" (C17). */
  firstOpen: string | null
  /**
   * No game on the court, the night not over, and a market still to open (S2, S3): the board note
   * says how one opens (C18).
   */
  note: boolean
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
      list: [],
      later: [],
      dial: [],
      empty: 'Setting the dial…',
      filtered: false,
      next: null,
      chainNow: now,
      label,
      rest: null,
      calendar: null,
      stopped: null,
      openNow: 0,
      firstOpen: null,
      note: false,
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
  const coming = upcomingOf(games, now) ?? upcoming
  const ahead = coming && coming.tip > now ? coming : null
  const over = nightOver(games, now)
  // The dial rests only on an empty 24 h list (first-screen spec S1, W4): a listed slate, even the
  // next night's, keeps its pre-open arcs and its numbers. A night whose games all stopped is
  // over, not at rest, even once they left the 4 h window.
  const night = etNight(now)
  const resting = tonight.length === 0 && !over
  const restNext = resting ? (aheadOf(games, now) ?? ahead) : null
  const open = items.filter(openNow).length
  // A market still to open: no market yet, and the game has not started (stillTrades).
  const waiting = items.filter((i) => !i.market && i.trading)
  const opensAt = Math.min(...waiting.map((i) => i.interval.start).filter((t) => t > now))
  const anyLive = tonight.some((g) => g.status === 'live')
  // Before any market opens, the calendar link sits under the list (S2): the first listed tip-off.
  const listNext = open === 0 && !anyLive && !over ? aheadOf(tonight, now) : null
  const calendarNext = restNext ?? listNext
  // Every listed game is of a later night: head the list with that night's date, not tonight's.
  const firstListed = Math.min(...tonight.map(tipOf))
  const laterOnly = tonight.length > 0 && !tonight.some((g) => ofNight(g, night))
  const byNight = new Map<string, BoardItem[]>()
  if (!laterOnly) {
    for (const i of items) {
      if (ofNight(i.game, night)) continue
      const day = etDay(tipOf(i.game))
      byNight.set(day, [...(byNight.get(day) ?? []), i])
    }
  }
  const later = [...byNight.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, rows]) => ({
      label: nextLabel(Math.min(...rows.map((i) => tipOf(i.game))), rows.length),
      items: rows,
    }))
  const list = laterOnly ? items : items.filter((i) => ofNight(i.game, night))
  const base = {
    teams,
    items,
    list,
    later,
    dial: resting ? [] : items,
    chainNow,
    label: laterOnly ? nextLabel(firstListed, list.length) : boardLabel(now, list.length),
    rest: resting ? restLine(restNext, now) : null,
    calendar: calendarNext ? calendarLink(calendarNext) : null,
    stopped: over ? stoppedLine(aheadOf(games, now)?.tip ?? ahead?.tip ?? null, now) : null,
    openNow: open,
    // Once the night is over (S5) the board's first line is string 21, "All stopped. Next tip-off
    // …": the next night's opens belong to S2 (C17), its note to S2/S3 (C18), and either one over
    // a night whose markets all stopped reads as if tonight's had not opened yet.
    firstOpen:
      open === 0 && !over && Number.isFinite(opensAt)
        ? `First market opens ${inMinutes(opensAt - now)}`
        : null,
    note: !anyLive && !over && waiting.length > 0,
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
