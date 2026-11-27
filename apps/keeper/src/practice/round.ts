// One round of the Practice process (R8), every 5 s: its own Keeper ticks the PRACTICE games
// (create, halt at the buzzer, draft, auto-propose with `replay` evidence, finalize, recycle),
// and at each slot a new run starts once its guards pass. A failed guard skips the slot and
// says why. FLAG_PRACTICE off starts no run; a run in flight still settles.
import {
  countGames,
  type Db,
  type GameWithMarkets,
  listGames,
  readFlags,
  upsertScheduledGames,
} from '@horagon/db'
import type { ReplayGame } from '@horagon/sdk/replay'
import type { Keypair } from '@solana/web3.js'
import type { Logger } from 'pino'
import type { Alerter } from '../alerts'
import type { Ratings } from '../elo'
import type { TxSender } from '../executor'
import type { Feed } from '../feeds/types'
import { DEFAULT_TIMINGS, type SeedPolicy } from '../planner'
import { Keeper, type KeeperDeps } from '../tick'
import { authorityReserve, LAMPORTS_PER_MARKET, upcomingGames } from '../treasury'
import {
  PRACTICE_LEAD_SECS,
  PRACTICE_SEED,
  PRACTICE_SEEDS,
  PRACTICE_SPEED,
  type PracticeRunRow,
  practiceRun,
  scaleTimings,
} from './runs'
import { dueSlot, nextSlots, PRACTICE_FOOTPRINT_SECS, PRACTICE_SLOT_GRACE_SECS } from './slots'

/** The Practice keeper's timings: the main keeper's defaults at 6x. */
export const PRACTICE_TIMINGS = scaleTimings(DEFAULT_TIMINGS, PRACTICE_SPEED)
/** An NBA game's window opens this long before its tip-off: its market's create. */
const NBA_LEAD_SECS = DEFAULT_TIMINGS.createLeadSecs
/** And closes at its Final, or at end_ts at the latest. */
const NBA_CLOSE_SECS = DEFAULT_TIMINGS.endOffsetSecs
/** How far back the round reads Practice games (the Keeper's own reach). */
const PRACTICE_BACK_SECS = 8 * 86_400

/**
 * The Keeper's own pages the guardian's chat never needs for a Practice run: it drafts, proposes
 * and halts by itself, and a challenge pages `practice-challenged:` instead. Every other key
 * (a rejected send, a stuck market, periods that do not add up) still goes out.
 */
const QUIET_KEYS: ReadonlySet<string> = new Set(['draft', 'auto-proposed', 'halt', 'challenge'])

/** The Practice Keeper's alerter: `alerts` without the keys a Practice run needs nobody for. */
export function practiceKeeperAlerts(alerts: Alerter): Alerter {
  return {
    send: async (key, text) => {
      if (QUIET_KEYS.has(key.split(':')[0] ?? '')) return true
      return alerts.send(key, text)
    },
  }
}

export interface PracticeKeeperInput
  extends Pick<
    KeeperDeps,
    | 'db'
    | 'program'
    | 'attestor'
    | 'log'
    | 'now'
    | 'sigma'
    | 'priority'
    | 'feedEverySecs'
    | 'newMarketId'
  > {
  sender: TxSender
  feed: Feed
  attestor: Keypair
  alerts: Alerter
  /** `evidenceUri` of a game, from HORAGON_PUBLIC_URL. */
  evidenceUri: (gameId: string) => string
}

/**
 * The Practice process's Keeper: PRACTICE games only, timings at 6x, 300 mUSDC seeds, and
 * auto-propose for PRACTICE with no second source (its period sums are still checked). Its
 * creates take the same path as the main keeper's: a random market id stored before the send.
 */
export function practiceKeeper(i: PracticeKeeperInput): Keeper {
  return new Keeper({
    db: i.db,
    sender: i.sender,
    program: i.program,
    attestor: i.attestor,
    feed: i.feed,
    alerts: practiceKeeperAlerts(i.alerts),
    log: i.log,
    now: i.now,
    timings: PRACTICE_TIMINGS,
    seeds: PRACTICE_SEEDS,
    sigma: i.sigma,
    priority: i.priority,
    feedEverySecs: i.feedEverySecs ?? 5,
    // Absent: R9's random id, stored before the create is sent, as on an NBA night. A Practice
    // market lives on devnet too, so an id anyone could compute could be squatted the same way.
    newMarketId: i.newMarketId,
    leagues: ['PRACTICE'],
    autoPropose: {
      mode: 'on',
      evidenceUri: i.evidenceUri,
      secondSource: null,
      leagues: ['PRACTICE'],
    },
  })
}

export type SkipReason =
  | 'flag-off'
  | 'run-unsettled'
  | 'nba-window'
  | 'balance-unread'
  | 'sol-floor'
  | 'sol-authority'
  | 'seed-short'

export interface SkipInput {
  /** The slot's start (unix seconds). */
  start: number
  now: number
  flagOn: boolean
  /** NBA games near the slot. */
  nba: readonly GameWithMarkets[]
  /** Practice games of the last days. */
  practice: readonly GameWithMarkets[]
  /** The attestor's SOL, or null when it could not be read. */
  attestorLamports: bigint | null
  solFloorLamports: bigint
  /** The Authority PDA's SOL, which pays every market's rent; null when it could not be read. */
  authorityLamports: bigint | null
  /** What the Authority keeps for 2 NBA nights of markets (`authorityReserve`). */
  authorityReserveLamports: bigint
  /** mUSDC that can seed markets (treasury + keeper wallet), or null when unread. */
  seedFunds: bigint | null
  /** The seeds of the NBA games of the next 36 h with no market yet. */
  nbaSeeds: readonly bigint[]
}

const UNSETTLED: ReadonlySet<string> = new Set(['open', 'halted', 'proposed', 'challenged'])

/** A Practice run not settled yet: its market trades or waits for a result, or is to be created. */
function unsettled(g: GameWithMarkets, now: number): boolean {
  const m = g.markets.find((x) => x.kind === 0)
  if (m) return UNSETTLED.has(m.status)
  const tip = Math.floor(g.scheduledTipoff.getTime() / 1000)
  return g.status === 'scheduled' && now < tip + PRACTICE_TIMINGS.createGraceSecs
}

/**
 * An NBA game's window [tip - 60 min, close], the close being its Final, or end_ts at the
 * latest. A game not played has none.
 */
export function nbaWindow(g: GameWithMarkets): [number, number] | null {
  if (g.status === 'postponed' || g.status === 'canceled') return null
  const tip = Math.floor(g.scheduledTipoff.getTime() / 1000)
  const close =
    g.status === 'final' && g.feedUpdatedAt
      ? Math.floor(g.feedUpdatedAt.getTime() / 1000)
      : tip + NBA_CLOSE_SECS
  return [tip - NBA_LEAD_SECS, Math.min(close, tip + NBA_CLOSE_SECS)]
}

/** True when an NBA window overlaps [start, start + 90 min]: real nights come first. */
export function nbaBlocks(nba: readonly GameWithMarkets[], start: number): boolean {
  const end = start + PRACTICE_FOOTPRINT_SECS
  return nba.some((g) => {
    const w = nbaWindow(g)
    return w !== null && w[0] < end && start < w[1]
  })
}

/** Why the run of this slot must not start, or null when every guard holds. Pure. */
export function practiceSkip(i: SkipInput): SkipReason | null {
  if (!i.flagOn) return 'flag-off'
  if (i.practice.some((g) => unsettled(g, i.now))) return 'run-unsettled'
  if (nbaBlocks(i.nba, i.start)) return 'nba-window'
  if (i.attestorLamports === null || i.authorityLamports === null || i.seedFunds === null)
    return 'balance-unread'
  if (i.attestorLamports < i.solFloorLamports) return 'sol-floor'
  // The Authority pays the run's market rent too: after it, 2 NBA nights must still be covered.
  if (i.authorityLamports < i.authorityReserveLamports + LAMPORTS_PER_MARKET) return 'sol-authority'
  const need = i.nbaSeeds.reduce((a, b) => a + b, 0n) + PRACTICE_SEED
  if (i.seedFunds < need) return 'seed-short'
  return null
}

/** The skips a balance causes: until it is topped up, every slot would skip the same way. */
const FUNDS_SKIPS: ReadonlySet<SkipReason> = new Set(['sol-floor', 'sol-authority', 'seed-short'])

/** When a run started: its tip-off is PRACTICE_LEAD_SECS later. */
const startOf = (g: GameWithMarkets) =>
  Math.floor(g.scheduledTipoff.getTime() / 1000) - PRACTICE_LEAD_SECS

export interface NextInput {
  now: number
  /** The coming slot starts, earliest first. */
  slots: readonly number[]
  /** NBA games near those slots. */
  nba: readonly GameWithMarkets[]
  /** Practice games of the last days. */
  practice: readonly GameWithMarkets[]
}

/**
 * The first slot the run guards will not skip, as far as the games tell (the balances are the
 * caller's), else null. A challenged run holds back every later run until a guardian proposes it
 * again, and so does a run still unsettled past its footprint: no slot is promised while either
 * waits. A run in flight holds back the slots inside its footprint only. Pure.
 */
export function nextFreeSlot(i: NextInput): number | null {
  const runs = i.practice.filter((g) => unsettled(g, i.now))
  const stuck = runs.some(
    (g) =>
      g.markets.some((m) => m.kind === 0 && m.status === 'challenged') ||
      startOf(g) + PRACTICE_FOOTPRINT_SECS <= i.now,
  )
  if (stuck) return null
  const settledBy = Math.max(0, ...runs.map((g) => startOf(g) + PRACTICE_FOOTPRINT_SECS))
  return i.slots.find((s) => s >= settledBy && !nbaBlocks(i.nba, s)) ?? null
}

const SKIP_TEXT: Readonly<Record<SkipReason, string>> = {
  'flag-off': 'FLAG_PRACTICE is off',
  'run-unsettled': 'another Practice run is not settled',
  'nba-window': 'an NBA market is open or opens within 90 min',
  'balance-unread': 'a balance could not be read',
  'sol-floor': 'the attestor holds less SOL than PRACTICE_SOL_FLOOR',
  'sol-authority': 'the Authority holds less SOL than 2 NBA nights of markets plus one',
  'seed-short': 'mUSDC is short of the next NBA seeds plus 300',
}

export interface PracticeBalances {
  /** The attestor's SOL, in lamports: it pays the fees. */
  attestorLamports(): Promise<bigint>
  /** The Authority PDA's SOL, in lamports: it pays each market's rent (about 0.036 SOL). */
  authorityLamports(): Promise<bigint>
  /** mUSDC that can seed markets: the treasury plus the keeper wallet. */
  seedFunds(): Promise<bigint>
}

export interface PracticeArenaDeps {
  db: Db
  keeper: Pick<Keeper, 'tick'>
  feed: { setRuns(rows: readonly PracticeRunRow[]): void }
  alerts: Alerter
  log: Logger
  now: () => number
  fixtures: readonly ReplayGame[]
  ratings: Ratings
  /** The main keeper's seed policy: what the NBA games of the next 36 h need. */
  nbaSeeds: SeedPolicy
  solFloorLamports: bigint
  balances: PracticeBalances
}

export interface PracticeRound {
  /** Actions of this round's Keeper tick. */
  actions: number
  /** The game id of the run started this round. */
  started: string | null
  /** Why the slot of this round was skipped. */
  skipped: SkipReason | null
  /** The tip-off of the next run that can start (unix seconds); null with FLAG_PRACTICE off. */
  nextAt: number | null
}

/**
 * How often the next tip-off rechecks the balances between slots: a top-up shows within a
 * minute, at four balance reads a minute.
 */
export const FUNDS_RECHECK_SECS = 60

interface Funds {
  reason: SkipReason | null
  attestorLamports: bigint | null
  authorityLamports: bigint | null
  authorityReserveLamports: bigint
}

const read = async <T>(fn: () => Promise<T>): Promise<T | null> => {
  try {
    return await fn()
  } catch {
    return null
  }
}

export class PracticeArena {
  /** Slots already tried by this process: a slot is tried once. */
  private readonly tried = new Set<number>()
  /** The last skip, kept for the heartbeat until a run starts. */
  private lastSkip: SkipReason | null = null
  /** The balance guards' last answer (a skip reason or null) and when it was read. */
  private funds: { at: number; reason: SkipReason | null } | null = null

  constructor(private readonly d: PracticeArenaDeps) {}

  private async practiceGames(now: number): Promise<GameWithMarkets[]> {
    return listGames(this.d.db, {
      from: new Date((now - PRACTICE_BACK_SECS) * 1000),
      to: new Date((now + 86_400) * 1000),
      leagues: ['PRACTICE'],
    })
  }

  private async nbaNear(from: number, to: number): Promise<GameWithMarkets[]> {
    return listGames(this.d.db, {
      from: new Date((from - NBA_CLOSE_SECS) * 1000),
      to: new Date((to + NBA_LEAD_SECS) * 1000),
      leagues: ['NBA'],
    })
  }

  async round(): Promise<PracticeRound> {
    const now = this.d.now()
    let practice = await this.practiceGames(now)
    this.d.feed.setRuns(practice)
    const actions = (await this.d.keeper.tick()).length
    // A challenged run waits for a guardian (runbook, "Practice") and holds back every later run.
    for (const g of practice) {
      if (g.markets.some((m) => m.kind === 0 && m.status === 'challenged')) {
        await this.d.alerts.send(
          `practice-challenged:${g.id}`,
          `Practice ${g.away}@${g.home} (${g.id}) was challenged: no Practice run starts until a guardian proposes it again: horagon-ops propose ${g.id} --box-score <url> --score <h>-<a>`,
        )
      }
    }

    let started: string | null = null
    const slot = dueSlot(now)
    if (slot !== null && !this.tried.has(slot) && !this.ranFor(practice, slot)) {
      this.tried.add(slot)
      const reason = await this.guard(slot, now, practice)
      if (reason) {
        this.lastSkip = reason
        this.d.log.info({ slot, reason }, `practice slot skipped: ${SKIP_TEXT[reason]}`)
      } else {
        const run = practiceRun({
          n: await countGames(this.d.db, 'PRACTICE'),
          now,
          fixtures: this.d.fixtures,
          ratings: this.d.ratings,
        })
        await upsertScheduledGames(this.d.db, [run])
        started = run.id
        this.lastSkip = null
        this.d.log.info({ slot, gameId: run.id }, 'practice run started')
        practice = await this.practiceGames(now)
        this.d.feed.setRuns(practice)
      }
    }
    return {
      actions,
      started,
      skipped: started ? null : this.lastSkip,
      nextAt: await this.nextAt(now, practice),
    }
  }

  /** A run already started for this slot (by this process before a restart). */
  private ranFor(practice: readonly GameWithMarkets[], slot: number): boolean {
    const from = (slot + PRACTICE_LEAD_SECS) * 1000
    const to = (slot + PRACTICE_LEAD_SECS + PRACTICE_SLOT_GRACE_SECS) * 1000
    return practice.some((g) => {
      const t = g.scheduledTipoff.getTime()
      return t >= from && t <= to
    })
  }

  private async guard(
    slot: number,
    now: number,
    practice: readonly GameWithMarkets[],
  ): Promise<SkipReason | null> {
    const flagOn = (await readFlags(this.d.db)).FLAG_PRACTICE
    // The cheap guards first: no RPC read for a slot that cannot start anyway.
    const early = practiceSkip({
      start: slot,
      now,
      flagOn,
      nba: await this.nbaNear(slot, slot + PRACTICE_FOOTPRINT_SECS),
      practice,
      attestorLamports: 0n,
      solFloorLamports: 0n,
      authorityLamports: 0n,
      authorityReserveLamports: 0n,
      seedFunds: null,
      nbaSeeds: [],
    })
    if (early !== 'balance-unread') return early
    const f = await this.readFunds(now)
    const sol = (l: bigint | null) => Number(l ?? 0n) / 1e9
    if (f.reason === 'sol-floor') {
      await this.d.alerts.send(
        'practice-sol-floor',
        `Practice paused: the attestor holds ${sol(f.attestorLamports)} SOL, under the floor of ${sol(this.d.solFloorLamports)}. NBA nights keep the SOL for their fees; top up from the devnet faucet for more Practice runs.`,
      )
    }
    if (f.reason === 'sol-authority') {
      await this.d.alerts.send(
        'practice-sol-authority',
        `Practice paused: the Authority holds ${sol(f.authorityLamports)} SOL, under 2 NBA nights of markets plus one Practice market (${sol(f.authorityReserveLamports + LAMPORTS_PER_MARKET)}). It pays every market's rent: horagon-ops fund-authority`,
      )
    }
    return f.reason
  }

  /** The balance guards (`balance-unread`, `sol-floor`, `sol-authority`, `seed-short`), read now. */
  private async readFunds(now: number): Promise<Funds> {
    const [attestorLamports, authorityLamports, seedFunds, nbaGames] = await Promise.all([
      read(() => this.d.balances.attestorLamports()),
      read(() => this.d.balances.authorityLamports()),
      read(() => this.d.balances.seedFunds()),
      upcomingGames({ db: this.d.db, now: this.d.now }),
    ])
    const { featured, regular } = this.d.nbaSeeds
    const nbaSeeds = nbaGames.map((g) => (g.featured ? featured : regular))
    const authorityReserveLamports = authorityReserve(nbaGames)
    const reason = practiceSkip({
      start: now,
      now,
      flagOn: true,
      nba: [],
      practice: [],
      attestorLamports,
      solFloorLamports: this.d.solFloorLamports,
      authorityLamports,
      authorityReserveLamports,
      seedFunds,
      nbaSeeds,
    })
    // An unread balance is no answer: the last answer stands.
    if (reason !== 'balance-unread' || this.funds === null) this.funds = { at: now, reason }
    else this.funds = { ...this.funds, at: now }
    return { reason, attestorLamports, authorityLamports, authorityReserveLamports }
  }

  /**
   * The tip-off of the next run that can start, within 3 days; null with the flag off, while a
   * balance guard would skip every slot (`sol-floor`, `sol-authority`, `seed-short`, rechecked
   * every FUNDS_RECHECK_SECS), and while a run waits for a guardian (`nextFreeSlot`). The page
   * never promises a tip-off the guards will skip.
   */
  private async nextAt(now: number, practice: readonly GameWithMarkets[]): Promise<number | null> {
    if (!(await readFlags(this.d.db)).FLAG_PRACTICE) return null
    const slots = nextSlots(now, 18)
    const first = slots[0]
    const last = slots.at(-1)
    if (first === undefined || last === undefined) return null
    const nba = await this.nbaNear(first, last + PRACTICE_FOOTPRINT_SECS)
    const free = nextFreeSlot({ now, slots, nba, practice })
    if (free === null) return null
    if (this.funds === null || now - this.funds.at >= FUNDS_RECHECK_SECS) await this.readFunds(now)
    const reason = this.funds?.reason ?? null
    if (reason !== null && FUNDS_SKIPS.has(reason)) return null
    return free + PRACTICE_LEAD_SECS
  }
}
