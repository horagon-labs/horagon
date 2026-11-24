// The board's rows (spec 4.1): one per game, built from the winner market (the UI shows no
// second-half market), the wallet's positions and the shared clock.
import {
  effectiveTime,
  formatAmount,
  type Game,
  type MarketSummary,
  type PositionsResponse,
  parseAmount,
} from '@horagon/sdk'
import { isTonight, usdc } from '../format'
import { timeLeftFraction } from './geometry'
import { type DialState, deriveDialState, dialLabel, needlePrice, secsToClose } from './state'
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
  return {
    id: game.id,
    game,
    market,
    state,
    price: needlePrice(state, market),
    // MarketSummary has no startTs: tip-off - 60 min stands in for it (spec 4.1).
    timeLeft: market
      ? timeLeftFraction(interval.start, market.endTs, effectiveTime(now, market.priceTs ?? 0))
      : 1,
    secsLeft: secsToClose(market, now),
    held: holds(portfolio, game.id),
    interval,
  }
}

const AFTER_TRADING: readonly DialState[] = ['closed', 'halted', 'proposed', 'challenged']

/** 0 trading now, 1 not started, 2 waiting for a result, 3 resolved or void. */
function group(i: BoardItem): number {
  if (i.state === 'resolved' || i.state === 'void') return 3
  if (AFTER_TRADING.includes(i.state)) return 2
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

/** The YourHour chip (spec 3.2): open positions and what they are worth now. */
export function yourHour(
  portfolio: PositionsResponse | undefined,
): { count: number; value: string } | null {
  if (!portfolio) return null
  const open = portfolio.positions.filter((p) => parseAmount(p.shares) > 0n)
  const value = open.reduce((sum, p) => sum + parseAmount(p.valueUsdc), 0n)
  return { count: open.length, value: usdc(formatAmount(value)) }
}

/** What a screen reader hears for one game, on its row link and in the Night dial's list. */
export function itemLabel(i: BoardItem): string {
  const g = i.game
  const teams =
    g.status === 'scheduled'
      ? `${g.away} at ${g.home}`
      : `${g.away} ${g.awayScore}, ${g.home} ${g.homeScore}`
  const words = dialLabel({
    team: g.home,
    price: i.price,
    modelProb: g.modelProb,
    state: i.state,
    secsLeft: i.secsLeft,
    gameStatus: g.status,
  })
  return `${teams}. ${words}${i.held ? '. You hold a position' : ''}`
}

export interface BoardModel {
  /** Every team playing tonight, for the follow chips. */
  teams: string[]
  /** The rows after the follow filter, in list order. */
  items: BoardItem[]
  /** The line for an empty board, with the words the board already uses; null with rows. */
  empty: string | null
  /** The Night dial's clock (spec 5.4): `now` moved up to the newest winner `priceTs` the board has seen. */
  chainNow: number
}

/** Tonight's board (spec 4.1, 4.4): the 24-hour filter, the follow filter and the list order. */
export function boardModel(
  games: Game[] | undefined,
  portfolio: PositionsResponse | undefined,
  now: number,
  follows: readonly string[],
): BoardModel {
  if (games === undefined) return { teams: [], items: [], empty: 'Loading games…', chainNow: now }
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
  if (items.length > 0) return { teams, items, empty: null, chainNow }
  const empty =
    follows.length > 0
      ? 'No games for the teams you follow in the next 24 hours.'
      : 'No NBA games in the next 24 hours.'
  return { teams, items, empty, chainNow }
}
