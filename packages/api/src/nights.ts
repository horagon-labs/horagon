// GET /api/v1/nights/{date} (first-screen story, spec W1): each final NBA game of one ET date with
// a winner market, told from the winner's side, so the first screen reads one answer instead of
// a /history per game. The opening and closing price, whether the price moved, the low, the
// model and price lines (at most NIGHT_POINTS each, low and high kept) and who traded. Practice
// (league PRACTICE) never counts. `nightGame` is pure; `nightFor` reads the DB.
import {
  type Db,
  type GameWithMarkets,
  latestPrices,
  listGames,
  listMarketTrades,
  listPricePoints,
  listSnapshotsOf,
  type PricePointRow,
  type SnapshotRow,
  type TradeRow,
  walletsWithBotMemo,
} from '@horagon/db'
import {
  etDayRange,
  type MarketStatus,
  NIGHT_POINTS,
  type Night,
  type NightGame,
  type NightLow,
  type NightPoint,
} from '@horagon/sdk'
import { isUpset, winnerOpened } from '@horagon/sdk/study'
import { gameActivity } from './activity'
import { challengeEndsAt } from './dispute-window'

export { NIGHT_POINTS }

/** A price this close to the opening one (half a point) has not moved. */
export const MOVED_MIN = 0.005

const secs = (d: Date) => Math.floor(d.getTime() / 1000)

/**
 * At most `max` points of `points` (time order kept): the first and the last, the lowest and the
 * highest, every index in `keep`, then evenly spaced ones. A line that fits is returned whole.
 */
export function downsample(
  points: readonly NightPoint[],
  keep: readonly number[] = [],
  max = NIGHT_POINTS,
): NightPoint[] {
  if (points.length <= max) return [...points]
  let lo = 0
  let hi = 0
  points.forEach(([, p], i) => {
    if (p < (points[lo] as NightPoint)[1]) lo = i
    if (p > (points[hi] as NightPoint)[1]) hi = i
  })
  const last = points.length - 1
  const chosen = new Set([0, last, lo, hi, ...keep.filter((i) => i >= 0 && i <= last)])
  // Even steps over the rest, until `max`: each step adds an index not chosen yet.
  const room = max - chosen.size
  for (let k = 1; k <= room; k++) chosen.add(Math.round((k * last) / (room + 1)))
  for (let i = 1; chosen.size < max && i < last; i++) chosen.add(i)
  return [...chosen].sort((a, b) => a - b).map((i) => points[i] as NightPoint)
}

export interface NightInput {
  game: GameWithMarkets
  /** This game's snapshots, oldest first. */
  snapshots: readonly SnapshotRow[]
  /** The winner market's price points, oldest first. */
  prices: readonly PricePointRow[]
  /** The winner market's last indexed price. */
  latest: { price: number } | undefined
  /** The winner market's swaps. */
  trades: TradeRow[]
  /** Wallets that sent a `horagon:bot` swap on any market. */
  memoWallets: ReadonlySet<string>
  /** The on-chain challenge window, or null when it could not be read. */
  windowSecs: number | null
}

/** A snapshot the keeper wrote once the game was final: the feed's clock is gone. */
const isFinalState = (s: SnapshotRow) => s.clockSecs === null && s.period >= 4

/**
 * The night's view of one game, or null when it is not a final NBA game with a winner market and
 * a winner. The model line runs from tip-off to the first Final snapshot (score fixes written
 * later are not drawn); the price line from the open to that same moment.
 */
export function nightGame(i: NightInput): NightGame | null {
  const g = i.game
  const m = g.markets.find((x) => x.kind === 0)
  if (!m || g.status !== 'final' || g.homeScore === g.awayScore) return null
  const homeWon = g.homeScore > g.awayScore
  const side = (p: number) => (homeWon ? p : 1 - p)

  const played = i.snapshots.filter((s) => s.period >= 1 && s.modelProb !== null)
  const finalAt = played.find(isFinalState)
  const cut = finalAt ? secs(finalAt.ts) : Number.POSITIVE_INFINITY
  const kept = played.filter((s) => secs(s.ts) <= cut)
  const live = kept.filter((s) => s.clockSecs !== null)

  const scoreAt = (s: SnapshotRow) => ({
    period: s.period,
    clockSecs: s.clockSecs,
    winnerScore: homeWon ? s.homeScore : s.awayScore,
    loserScore: homeWon ? s.awayScore : s.homeScore,
  })

  // The model's low while the game was on (the Final snapshot has no clock); ties: the earliest.
  let modelLow = -1
  for (let k = 0; k < kept.length; k++) {
    const s = kept[k] as SnapshotRow
    if (s.clockSecs === null) continue
    const best = kept[modelLow]
    if (!best || side(s.modelProb as number) < side(best.modelProb as number)) modelLow = k
  }

  const priceLine: NightPoint[] = i.prices
    .filter((p) => secs(p.ts) <= cut)
    .map((p) => [secs(p.ts), side(p.price)])

  const activity = gameActivity(i.trades, i.memoWallets)
  const calls = {
    fans: activity.fans.swaps,
    fanWallets: activity.fans.wallets,
    agent: activity.agent.swaps,
    others: activity.others.swaps,
  }
  const total = calls.fans + calls.agent + calls.others
  const openedBps = winnerOpened(m.initialPriceBps, homeWon)
  const closed = i.latest ? side(i.latest.price) : null
  const moved = total > 0 && closed !== null && Math.abs(closed - openedBps / 10_000) >= MOVED_MIN

  // Once the price moved, the low is the price's while the game was on, with the score then.
  let priceLow = -1
  const first = live[0]
  if (moved && first) {
    for (let k = 0; k < priceLine.length; k++) {
      const [t, prob] = priceLine[k] as NightPoint
      const best = priceLine[priceLow]
      if (t >= secs(first.ts) && (!best || prob < best[1])) priceLow = k
    }
  }

  let low: NightLow | null = null
  const lowPrice = priceLine[priceLow]
  const lowModel = kept[modelLow]
  if (lowPrice) {
    const [t, prob] = lowPrice
    const at = live.filter((s) => secs(s.ts) <= t).at(-1) ?? (first as SnapshotRow)
    low = { ts: t, prob, ...scoreAt(at), from: 'price' }
  } else if (lowModel) {
    low = {
      ts: secs(lowModel.ts),
      prob: side(lowModel.modelProb as number),
      ...scoreAt(lowModel),
      from: 'model',
    }
  }

  const periodStarts: number[] = []
  for (const s of kept) {
    while (periodStarts.length < s.period) periodStarts.push(secs(s.ts))
  }

  return {
    id: g.id,
    home: g.home,
    away: g.away,
    homeScore: g.homeScore,
    awayScore: g.awayScore,
    winner: homeWon ? g.home : g.away,
    loser: homeWon ? g.away : g.home,
    scheduledTipoff: g.scheduledTipoff.toISOString(),
    period: g.period,
    market: m.pubkey,
    openedBps,
    closed,
    moved,
    upset: isUpset(m.initialPriceBps, homeWon),
    overtime: g.period >= 5,
    low,
    periodStarts,
    model: downsample(
      kept.map((s) => [secs(s.ts), side(s.modelProb as number)]),
      [modelLow],
    ),
    price: downsample(priceLine, [priceLow]),
    calls,
    resolution: {
      market: m.pubkey,
      status: m.status as MarketStatus,
      challengeEndsAt: challengeEndsAt(m.status, m.proposedAt, i.windowSecs),
    },
  }
}

/**
 * One ET night (`date`, YYYY-MM-DD): its final NBA games with a winner market, by tip-off. Five
 * reads for the whole night, whatever its size; the challenge window only while a result is
 * proposed.
 */
export async function nightFor(
  db: Db,
  date: string,
  disputeWindow: () => Promise<number | null>,
): Promise<Night> {
  const listed = await listGames(db, {
    ...etDayRange(date),
    statuses: ['final'],
    leagues: ['NBA'],
  })
  const winners = new Map(
    listed.flatMap((g) => {
      const m = g.markets.find((x) => x.kind === 0)
      return m ? [[g.id, m.pubkey] as const] : []
    }),
  )
  const keys = [...winners.values()]
  const proposed = listed.some((g) => g.markets.some((m) => m.status === 'proposed'))
  const [snapshots, prices, latest, trades, windowSecs] = await Promise.all([
    listSnapshotsOf(db, [...winners.keys()]),
    listPricePoints(db, keys),
    latestPrices(db, keys),
    listMarketTrades(db, keys),
    proposed ? disputeWindow() : Promise.resolve(null),
  ])
  const memoWallets = await walletsWithBotMemo(db, [...new Set(trades.map((t) => t.wallet))])
  const games = listed.flatMap((game) => {
    const key = winners.get(game.id)
    const g = nightGame({
      game,
      snapshots: snapshots.filter((s) => s.gameId === game.id),
      prices: prices.filter((p) => p.market === key),
      latest: key === undefined ? undefined : latest.get(key),
      trades: trades.filter((t) => t.market === key),
      memoWallets,
      windowSecs,
    })
    return g ? [g] : []
  })
  return { date, upsets: games.filter((g) => g.upset).length, games }
}
