// My Game-day (R7, FLAG_ME): one view of a wallet's games tonight, and "You vs the model".
//
// A call is a buy of a side: its model is the side's model win chance at each buy (the newest
// game snapshot at or before it, else the pre-game p0; 1 - m for the away side), weighted by the
// shares each buy gained. Once the result is final it scores round(100 * (won ? 1 : 0) - 100 * m),
// and the night scores round(100 * sum(won - m)) over its settled NBA calls: summed first, then
// rounded. The model expects 0. Anyone can recompute it from /games/{id}/history.
//
// Every DB read of the route lives here. The helpers above the reads are pure and tested apart.
import { z } from '@hono/zod-openapi'
import {
  type Db,
  type GameRow,
  type GameWithMarkets,
  gamesByIds,
  latestPrices,
  listGames,
  listSnapshots,
  type MarketRow,
  marketsByPubkeys,
  type SnapshotRow,
  type TradeRow,
  walletActivity,
} from '@horagon/db'
import {
  etNight,
  etToday,
  FIRST_COUNTED_NIGHT,
  formatAmount,
  type MeCall,
  type MeGame,
  type MePosition,
  type MeResponse,
  type MeStatus,
  marketKindName,
  type Position,
  parseAmount,
  type Side,
} from '@horagon/sdk'
import { challengeEndsAt } from './dispute-window'
import { aggregatePositions } from './positions'
import { toGame } from './views'

const secs = (d: Date) => Math.floor(d.getTime() / 1000)

const NBA = 'NBA'
/** Practice games (R8's replays) carry this league (docs/metrics.md: never counted). */
export const PRACTICE_LEAGUE = 'PRACTICE'
const RESOLVED: ReadonlySet<string> = new Set(['finalized', 'recycled'])
/** A game that was not played as scheduled is never scored. */
const UNSCORED: ReadonlySet<string> = new Set(['postponed', 'canceled'])
/** The market kinds that count toward the nights (docs/metrics.md "Counted market"). */
const COUNTED_KINDS: ReadonlySet<number> = new Set([0, 2])
/** A settled Practice game stays on the page this long after it finalized. */
const PRACTICE_KEEP_SECS = 12 * 3600
const NEXT_DAYS = 8
const NEXT_MAX = 5

/** `?teams=MEM,LAC`: at most 30 team codes. */
export const MeQuerySchema = z.strictObject({
  teams: z
    .string()
    .transform((s) => s.split(','))
    .pipe(
      z
        .array(z.string().regex(/^[A-Z]{2,5}$/, 'a team code such as MEM'))
        .max(30, 'at most 30 teams'),
    )
    .optional(),
})

/** The night of `now`: the ET date of now - 6 h, so it rolls over at 06:00 ET (`etNight`). */
export const meNight = (now: number): string => etNight(now)

/**
 * A market's state on My Game-day, in this order: resolved is `final`; then `challenged`; then
 * `proposed`; then `closed` once the game is final (the final buzzer closes it everywhere), the
 * market halted, or end_ts passed; otherwise `open`.
 */
export function meStatus(
  m: Pick<MarketRow, 'status' | 'endTs'>,
  g: Pick<GameRow, 'status'>,
  now: number,
): MeStatus {
  if (RESOLVED.has(m.status)) return 'final'
  if (m.status === 'challenged') return 'challenged'
  if (m.status === 'proposed') return 'proposed'
  if (g.status === 'final' || m.status === 'halted' || now >= secs(m.endTs)) return 'closed'
  return 'open'
}

type Snap = Pick<SnapshotRow, 'ts' | 'modelProb'>

/** The home side's model at `at`: the newest snapshot at or before it, else p0 (snapshots oldest first). */
export function modelAt(snapshots: readonly Snap[], at: Date, p0: number | null): number | null {
  let found: Snap | undefined
  for (const s of snapshots) {
    if (s.ts.getTime() > at.getTime()) break
    found = s
  }
  return found ? found.modelProb : p0
}

export interface Buy {
  at: Date
  /** Shares the buy gained, in base units. */
  shares: bigint
}

/**
 * A call's model: the side's chance at each buy, weighted by the shares it gained. Null with no
 * buy, or when any buy had no model to score against.
 */
export function callModel(
  buys: readonly Buy[],
  side: Side,
  snapshots: readonly Snap[],
  p0: number | null,
): number | null {
  let weight = 0
  let sum = 0
  for (const b of buys) {
    const home = modelAt(snapshots, b.at, p0)
    if (home === null) return null
    const w = Number(b.shares)
    sum += w * (side === 'home' ? home : 1 - home)
    weight += w
  }
  return weight > 0 ? sum / weight : null
}

type Result = MeCall['result']

/** round(100 * (won ? 1 : 0) - 100 * model); null until both are known. */
export function scoreCall(model: number | null, result: Result): number | null {
  if (model === null || result === null) return null
  return Math.round(100 * (result === 'won' ? 1 : 0) - 100 * model)
}

/** round(100 * sum(won - model)) over the settled calls: summed first, then rounded. */
export function vsPoints(
  calls: ReadonlyArray<{ model: number | null; result: Result }>,
): number | null {
  let sum = 0
  let settled = 0
  for (const c of calls) {
    if (c.model === null || c.result === null) continue
    sum += (c.result === 'won' ? 1 : 0) - c.model
    settled++
  }
  return settled === 0 ? null : Math.round(100 * sum)
}

/**
 * Distinct ET dates of the tip-offs of the NBA markets (kind 0 or 2) the wallet swapped on, from
 * FIRST_COUNTED_NIGHT on: the night of a swap is its game's, never the time of the swap.
 * Practice is never counted. A product count, never the 3-Night Fans number.
 */
export function nightsOf(
  trades: readonly Pick<TradeRow, 'market'>[],
  markets: readonly Pick<MarketRow, 'pubkey' | 'kind' | 'gameId'>[],
  games: readonly Pick<GameRow, 'id' | 'league' | 'scheduledTipoff'>[],
): number {
  const marketOf = new Map(markets.map((m) => [m.pubkey, m]))
  const gameOf = new Map(games.map((g) => [g.id, g]))
  const nights = new Set<string>()
  for (const t of trades) {
    const m = marketOf.get(t.market)
    if (!m || !COUNTED_KINDS.has(m.kind)) continue
    const g = gameOf.get(m.gameId)
    if (!g || g.league !== NBA) continue
    const night = etToday(secs(g.scheduledTipoff))
    if (night >= FIRST_COUNTED_NIGHT) nights.add(night)
  }
  return nights.size
}

/** A buy of `side`: shares of that side gained (a YES<->NO swap buys the side it gains). */
const gained = (t: TradeRow, side: Side): bigint => (side === 'home' ? t.yesDelta : t.noDelta)

function resultOf(m: MarketRow, side: Side): Result {
  if (!RESOLVED.has(m.status) || (m.outcome !== 'yes' && m.outcome !== 'no')) return null
  return (m.outcome === 'yes') === (side === 'home') ? 'won' : 'lost'
}

/** What the held shares pay if `side` wins, and the net after the cost of both sides. */
function ifWins(positions: readonly Position[], side: Side): MeGame['ifHomeWins'] {
  const shares = positions
    .filter((p) => p.side === side)
    .reduce((n, p) => n + parseAmount(p.shares), 0n)
  const cost = positions.reduce((n, p) => n + parseAmount(p.costUsdc), 0n)
  return { payoutUsdc: formatAmount(shares), netUsdc: formatAmount(shares - cost) }
}

const unique = <T>(xs: Iterable<T>): T[] => [...new Set(xs)]

/** The wallet's rows: its swaps and claims, the markets they touched and those markets' games. */
async function walletRows(db: Db, wallet: string) {
  const activity = await walletActivity(db, wallet)
  const keys = unique([...activity.trades, ...activity.claims].map((r) => r.market))
  const markets = await marketsByPubkeys(db, keys)
  return { ...activity, keys, markets }
}

/**
 * `/positions` with the nights (FLAG_ME on): the rows `positionsFor` reads, plus the games of
 * their markets.
 */
export async function positionsAndNights(
  db: Db,
  wallet: string,
): Promise<{ positions: Position[]; nights: number }> {
  const { trades, claims, keys, markets } = await walletRows(db, wallet)
  const [latest, games] = await Promise.all([
    latestPrices(db, keys),
    gamesByIds(
      db,
      markets.map((m) => m.gameId),
    ),
  ])
  const prices = new Map([...latest].map(([k, v]) => [k, v.price]))
  return {
    positions: aggregatePositions({ trades, claims, markets, prices }),
    nights: nightsOf(trades, markets, games),
  }
}

export interface MeInput {
  wallet: string
  /** Followed teams (`?teams=`). */
  teams: readonly string[]
  now: number
  /** The on-chain dispute window, or null when it could not be read (dispute-window.ts). */
  disputeWindow: () => Promise<number | null>
}

/** `GET /api/v1/me/{wallet}`: DB reads only, plus the window read when a result is proposed. */
export async function meFor(db: Db, input: MeInput): Promise<MeResponse> {
  const { wallet, now } = input
  const night = meNight(now)
  const [rows, upcoming] = await Promise.all([
    walletRows(db, wallet),
    listGames(db, {
      from: new Date(now * 1000),
      to: new Date((now + NEXT_DAYS * 86_400) * 1000),
      statuses: ['scheduled'],
    }),
  ])
  const { trades, claims, keys, markets } = rows
  const games = await gamesByIds(
    db,
    markets.map((m) => m.gameId),
  )
  // Which games are on the page: claims and settlement need no price, so a first pass decides.
  const loose = aggregatePositions({ trades, claims, markets, prices: new Map() })
  const marketOf = new Map(markets.map((m) => [m.pubkey, m]))
  const winnerHeld = (g: GameWithMarkets) =>
    loose.filter((p) => p.gameId === g.id && p.kind === 'winner')
  const tonight = games.filter(
    (g) =>
      g.league === NBA && etToday(secs(g.scheduledTipoff)) === night && winnerHeld(g).length > 0,
  )
  const practice = games.filter(
    (g) =>
      g.league === PRACTICE_LEAGUE &&
      winnerHeld(g).some((p) => {
        const m = marketOf.get(p.market)
        if (!m) return false
        const settledAt = m.finalizedAt ?? m.recycledAt
        return (
          !RESOLVED.has(m.status) ||
          p.claimable ||
          (settledAt !== null && now - secs(settledAt) < PRACTICE_KEEP_SECS)
        )
      }),
  )
  const shown = [...tonight, ...practice]
  const shownIds = new Set(shown.map((g) => g.id))
  // The same markets the calls are built from: every kind the API names 'winner' (0 and 2).
  const buyers = shown.filter((g) =>
    trades.some((t) => {
      const m = marketOf.get(t.market)
      return (
        m?.gameId === g.id &&
        marketKindName(m.kind) === 'winner' &&
        (t.yesDelta > 0n || t.noDelta > 0n)
      )
    }),
  )
  const proposed = shown.some((g) => g.markets.some((m) => m.status === 'proposed'))

  // The next game of every followed team and every NBA team the wallet held.
  const teams = unique([
    ...input.teams,
    ...games.filter((g) => g.league === NBA).flatMap((g) => [g.home, g.away]),
  ])
  const next = new Map<string, GameWithMarkets>()
  for (const team of teams) {
    const first = upcoming.find(
      (g) => g.league === NBA && !shownIds.has(g.id) && (g.home === team || g.away === team),
    )
    if (first) next.set(first.id, first)
  }
  const nextGames = [...next.values()]
    .sort(
      (a, b) =>
        a.scheduledTipoff.getTime() - b.scheduledTipoff.getTime() || a.id.localeCompare(b.id),
    )
    .slice(0, NEXT_MAX)

  const allKeys = unique([
    ...keys,
    ...[...shown, ...nextGames].flatMap((g) => g.markets.map((m) => m.pubkey)),
  ])
  const [latest, snapshots, windowSecs] = await Promise.all([
    latestPrices(db, allKeys),
    Promise.all(buyers.map(async (g) => [g.id, await listSnapshots(db, g.id)] as const)),
    proposed ? input.disputeWindow() : Promise.resolve(null),
  ])
  const snapsOf = new Map(snapshots)
  const prices = new Map([...latest].map(([k, v]) => [k, v.price]))
  const positions = aggregatePositions({ trades, claims, markets, prices })

  const nbaCalls: Array<{ model: number | null; result: Result }> = []
  const practiceCalls: Array<{ model: number | null; result: Result }> = []
  let pending = 0
  const entries: MeGame[] = shown.map((g) => {
    const isPractice = g.league === PRACTICE_LEAGUE
    const scored = !UNSCORED.has(g.status)
    const held = positions.filter((p) => p.gameId === g.id && p.kind === 'winner')
    const out: MePosition[] = held.map((p) => {
      const m = marketOf.get(p.market) as MarketRow
      const buys = trades
        .filter((t) => t.market === p.market && gained(t, p.side) > 0n)
        .map((t) => ({ at: t.blockTime, shares: gained(t, p.side) }))
      let call: MeCall | null = null
      if (buys.length > 0) {
        const model = callModel(buys, p.side, snapsOf.get(g.id) ?? [], g.p0)
        const result = resultOf(m, p.side)
        call = { model, result, points: scored ? scoreCall(model, result) : null }
        if (scored && model !== null) {
          if (isPractice) practiceCalls.push({ model, result })
          else {
            nbaCalls.push({ model, result })
            if (result === null) pending++
          }
        }
      }
      const shares = parseAmount(p.shares)
      const avg = shares > 0n ? Number(parseAmount(p.costUsdc)) / Number(shares) : null
      return {
        ...p,
        team: p.side === 'home' ? g.home : g.away,
        avgPrice: avg === null ? null : Math.min(1, avg),
        status: meStatus(m, g, now),
        challengeEndsAt: challengeEndsAt(m.status, m.proposedAt, windowSecs),
        call,
      }
    })
    const settled = held.some((p) => RESOLVED.has(marketOf.get(p.market)?.status ?? ''))
    return {
      game: toGame(g, latest),
      practice: isPractice,
      positions: out,
      ifHomeWins: settled ? null : ifWins(held, 'home'),
      ifAwayWins: settled ? null : ifWins(held, 'away'),
    }
  })

  const listed = new Set(entries.flatMap((e) => e.positions.map((p) => `${p.market}:${p.side}`)))
  return {
    wallet,
    night,
    now,
    nights: nightsOf(trades, markets, games),
    games: entries,
    vsModel: {
      points: vsPoints(nbaCalls),
      settled: nbaCalls.filter((c) => c.result !== null).length,
      pending,
      practicePoints: vsPoints(practiceCalls),
    },
    earlierClaimable: positions.filter((p) => p.claimable && !listed.has(`${p.market}:${p.side}`))
      .length,
    nextGames: nextGames.map((g) => toGame(g, latest)),
  }
}
