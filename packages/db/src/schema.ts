// Tier 1 tables of spec section 8 (plus `resolution_drafts`, the hand-off from the keeper to
// the guardian's `propose`). Raw token amounts are bigint (6 decimals); times are timestamptz.
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })
const raw = (name: string) => bigint(name, { mode: 'bigint' })

/** [home, away] points per period, regulation first, then each overtime. */
export type PeriodScores = Array<[number, number]>

export const games = pgTable(
  'games',
  {
    /** `nba-<espn event id>`. */
    id: text('id').primaryKey(),
    league: text('league').notNull(),
    externalId: text('external_id').notNull(),
    /** The league's own date for the game (US Eastern for the NBA), YYYY-MM-DD. */
    gameDate: text('game_date').notNull(),
    home: text('home').notNull(),
    away: text('away').notNull(),
    scheduledTipoff: ts('scheduled_tipoff').notNull(),
    /** scheduled | live | final | postponed | canceled */
    status: text('status').notNull(),
    homeScore: integer('home_score').notNull().default(0),
    awayScore: integer('away_score').notNull().default(0),
    period: smallint('period').notNull().default(0),
    clockSecs: integer('clock_secs'),
    periods: jsonb('periods').$type<PeriodScores>().notNull().default(sql`'[]'::jsonb`),
    featured: boolean('featured').notNull().default(false),
    /** Pre-game home win probability from Elo (spec section 7). */
    p0: doublePrecision('p0'),
    /**
     * Latest in-game home win probability (the YES side of a winner market), refreshed by the
     * keeper each tick. Shown to fans, and the target of the reference agent.
     */
    modelProb: doublePrecision('model_prob'),
    /** Last feed payload that changed this row, for the guardian and the replay archive. */
    feedUpdatedAt: ts('feed_updated_at'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('games_tipoff_idx').on(t.scheduledTipoff)],
)

export const gameSnapshots = pgTable(
  'game_snapshots',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => games.id),
    ts: ts('ts').notNull(),
    homeScore: integer('home_score').notNull(),
    awayScore: integer('away_score').notNull(),
    period: smallint('period').notNull(),
    clockSecs: integer('clock_secs'),
    modelProb: doublePrecision('model_prob'),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.ts] })],
)

export const markets = pgTable(
  'markets',
  {
    /** The pm-AMM market account. */
    pubkey: text('pubkey').primaryKey(),
    gameId: text('game_id')
      .notNull()
      .references(() => games.id),
    /** 0 = winner, 1 = second half. */
    kind: smallint('kind').notNull(),
    /** u64 as a decimal string (does not fit a signed bigint). */
    marketId: text('market_id').notNull().unique(),
    gameMarketPda: text('game_market_pda').notNull(),
    yesMint: text('yes_mint').notNull(),
    noMint: text('no_mint').notNull(),
    initialPriceBps: integer('initial_price_bps').notNull(),
    endTs: ts('end_ts').notNull(),
    seedAmount: raw('seed_amount').notNull(),
    /** open | halted | proposed | challenged | finalized | recycled */
    status: text('status').notNull(),
    outcome: text('outcome'),
    evidenceHash: text('evidence_hash'),
    challengeCount: smallint('challenge_count').notNull().default(0),
    externalLp: boolean('external_lp').notNull().default(false),
    createSig: text('create_sig'),
    haltSig: text('halt_sig'),
    proposeSig: text('propose_sig'),
    finalizeSig: text('finalize_sig'),
    recycleSig: text('recycle_sig'),
    proposedAt: ts('proposed_at'),
    finalizedAt: ts('finalized_at'),
    recycledAt: ts('recycled_at'),
    /** Newest signature the indexer has processed for this market. */
    indexCursor: text('index_cursor'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('markets_game_idx').on(t.gameId), index('markets_status_idx').on(t.status)],
)

/**
 * The market id the keeper drew for a game's market, stored before the create is sent. The id is
 * 8 random bytes (u64), so nobody can create its pm-AMM PDA first; a restart reuses the stored
 * id, so a create that landed unrecorded is adopted rather than made twice. An id whose PDA is
 * taken by someone else is replaced by a new one. Markets created before this table keep the
 * id in `markets.market_id` (derived from the game, spec 5.1).
 */
export const marketIdReservations = pgTable(
  'market_id_reservations',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => games.id),
    /** 0 = winner, 1 = second half. */
    kind: smallint('kind').notNull(),
    /** u64 as a decimal string. */
    marketId: text('market_id').notNull().unique(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.kind] })],
)

/** One pm-AMM swap; amounts are the signer's balance deltas in that transaction. */
export const trades = pgTable(
  'trades',
  {
    sig: text('sig').notNull(),
    ixIndex: smallint('ix_index').notNull(),
    market: text('market').notNull(),
    wallet: text('wallet').notNull(),
    direction: text('direction').notNull(),
    /** Absolute USDC leg (volume); 0 for YES<->NO. */
    usdcAmount: raw('usdc_amount').notNull(),
    usdcDelta: raw('usdc_delta').notNull(),
    yesDelta: raw('yes_delta').notNull(),
    noDelta: raw('no_delta').notNull(),
    fee: raw('fee').notNull(),
    slot: raw('slot').notNull(),
    blockTime: ts('block_time').notNull(),
    /**
     * The transaction carries the top-level `horagon:bot` memo (docs/metrics.md bot rule (a)).
     * Null: indexed before the column existed; `horagon-ops backfill-bot-memo` fills it.
     */
    botMemo: boolean('bot_memo'),
  },
  (t) => [
    primaryKey({ columns: [t.sig, t.ixIndex] }),
    index('trades_wallet_idx').on(t.wallet),
    index('trades_market_time_idx').on(t.market, t.blockTime),
  ],
)

export const pricePoints = pgTable(
  'price_points',
  {
    market: text('market').notNull(),
    ts: ts('ts').notNull(),
    /** YES price in [0, 1]. */
    price: doublePrecision('price').notNull(),
  },
  (t) => [primaryKey({ columns: [t.market, t.ts] })],
)

/** redeem_pair and claim_winnings, as balance deltas of the signer. */
export const redeemsClaims = pgTable(
  'redeems_claims',
  {
    sig: text('sig').notNull(),
    ixIndex: smallint('ix_index').notNull(),
    market: text('market').notNull(),
    wallet: text('wallet').notNull(),
    /** redeem | claim */
    kind: text('kind').notNull(),
    usdcAmount: raw('usdc_amount').notNull(),
    yesDelta: raw('yes_delta').notNull(),
    noDelta: raw('no_delta').notNull(),
    blockTime: ts('block_time').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sig, t.ixIndex] }), index('claims_wallet_idx').on(t.wallet)],
)

export const wallets = pgTable('wallets', {
  pubkey: text('pubkey').primaryKey(),
  nickname: text('nickname'),
  nicknameSig: text('nickname_sig'),
  /** human | bot | team. `team` wallets are excluded from every metric (spec 6.4). */
  kind: text('kind').notNull().default('human'),
  firstSeen: ts('first_seen').notNull().defaultNow(),
})

export const evidence = pgTable(
  'evidence',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => games.id),
    /** 0 = winner, 1 = second half. */
    kind: smallint('kind').notNull(),
    /** The exact JCS string whose sha256 is on chain. */
    json: text('json').notNull(),
    hash: text('hash').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.kind] })],
)

/** The keeper's draft once ESPN has shown Final for 60 s; the guardian's `propose` consumes it. */
export const resolutionDrafts = pgTable('resolution_drafts', {
  gameId: text('game_id')
    .primaryKey()
    .references(() => games.id),
  /** final | postponed */
  status: text('status').notNull(),
  homeScore: integer('home_score').notNull(),
  awayScore: integer('away_score').notNull(),
  periods: jsonb('periods').$type<PeriodScores>().notNull(),
  /** ESPN scoreboard URL and when the stable Final was first seen. */
  sourceUrl: text('source_url').notNull(),
  fetchedAt: ts('fetched_at').notNull(),
  /** pending | proposed | rejected */
  state: text('state').notNull().default('pending'),
  alertedAt: ts('alerted_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
})

export const sponsorLog = pgTable(
  'sponsor_log',
  {
    sig: text('sig').primaryKey(),
    wallet: text('wallet').notNull(),
    /** sha256(salt + ip), hex. Raw IPs are never stored. */
    ipHash: text('ip_hash').notNull(),
    /** Worst-case spend reserved before sending: fee plus rent of every ATA it creates. */
    lamports: raw('lamports').notNull(),
    ts: ts('ts').notNull().defaultNow(),
  },
  (t) => [index('sponsor_log_ts_idx').on(t.ts)],
)

/**
 * Token accounts whose rent the sponsor paid, found by the indexer in confirmed sponsored
 * transactions. The user owns them and can close them to any address, so the rent is spend,
 * not float; a close whose rent went anywhere but the sponsor is flagged (`closed_to`).
 */
export const sponsoredAtas = pgTable(
  'sponsored_atas',
  {
    ata: text('ata').notNull(),
    wallet: text('wallet').notNull(),
    mint: text('mint').notNull(),
    createdSig: text('created_sig').notNull(),
    createdAt: ts('created_at').notNull(),
    /** Last time the watcher saw the account (null: never checked). */
    checkedAt: ts('checked_at'),
    closedSig: text('closed_sig'),
    closedAt: ts('closed_at'),
    /**
     * Who received the rent on close. Two markers: 'unknown' when no close instruction was found,
     * and 'claim' when pm-AMM's claim_winnings closed it (rent to the user, never counted).
     */
    closedTo: text('closed_to'),
  },
  (t) => [
    // One row per creation: an ATA address is fixed by (wallet, mint), so the same address can be
    // created again after a close. At most one creation of an address is open at a time.
    primaryKey({ columns: [t.ata, t.createdSig] }),
    uniqueIndex('sponsored_atas_open_idx').on(t.ata).where(sql`${t.closedAt} is null`),
    index('sponsored_atas_wallet_idx').on(t.wallet),
  ],
)

export const rateLimits = pgTable('rate_limits', {
  key: text('key').primaryKey(),
  tokens: doublePrecision('tokens').notNull(),
  updatedAt: ts('updated_at').notNull(),
})

export const keeperHeartbeats = pgTable('keeper_heartbeats', {
  process: text('process').primaryKey(),
  ts: ts('ts').notNull(),
  info: jsonb('info').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
})

export const opsEvents = pgTable(
  'ops_events',
  {
    id: serial('id').primaryKey(),
    ts: ts('ts').notNull().defaultNow(),
    /** keeper | indexer | guardian | admin | ops */
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    gameId: text('game_id'),
    market: text('market'),
    sig: text('sig'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [index('ops_events_ts_idx').on(t.ts)],
)

/**
 * Tier 2 feature flags (spec 3.3). A flag with no row is off; `setFlag` (flags.ts) writes a row
 * and its `ops_events` line in one transaction. A row whose name is not in FLAG_NAMES is ignored.
 */
export const flags = pgTable('flags', {
  name: text('name').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  /** Who set it: `ops` for horagon-ops. */
  updatedBy: text('updated_by').notNull(),
})
