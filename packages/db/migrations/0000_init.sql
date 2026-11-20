CREATE TABLE "evidence" (
	"game_id" text NOT NULL,
	"kind" smallint NOT NULL,
	"json" text NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_game_id_kind_pk" PRIMARY KEY("game_id","kind")
);
--> statement-breakpoint
CREATE TABLE "game_snapshots" (
	"game_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"home_score" integer NOT NULL,
	"away_score" integer NOT NULL,
	"period" smallint NOT NULL,
	"clock_secs" integer,
	"model_prob" double precision,
	CONSTRAINT "game_snapshots_game_id_ts_pk" PRIMARY KEY("game_id","ts")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" text PRIMARY KEY NOT NULL,
	"league" text NOT NULL,
	"external_id" text NOT NULL,
	"game_date" text NOT NULL,
	"home" text NOT NULL,
	"away" text NOT NULL,
	"scheduled_tipoff" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"home_score" integer DEFAULT 0 NOT NULL,
	"away_score" integer DEFAULT 0 NOT NULL,
	"period" smallint DEFAULT 0 NOT NULL,
	"clock_secs" integer,
	"periods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"p0" double precision,
	"model_prob" double precision,
	"feed_updated_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "keeper_heartbeats" (
	"process" text PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"info" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"pubkey" text PRIMARY KEY NOT NULL,
	"game_id" text NOT NULL,
	"kind" smallint NOT NULL,
	"market_id" text NOT NULL,
	"game_market_pda" text NOT NULL,
	"yes_mint" text NOT NULL,
	"no_mint" text NOT NULL,
	"initial_price_bps" integer NOT NULL,
	"end_ts" timestamp with time zone NOT NULL,
	"seed_amount" bigint NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"evidence_hash" text,
	"challenge_count" smallint DEFAULT 0 NOT NULL,
	"external_lp" boolean DEFAULT false NOT NULL,
	"create_sig" text,
	"halt_sig" text,
	"propose_sig" text,
	"finalize_sig" text,
	"recycle_sig" text,
	"proposed_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"recycled_at" timestamp with time zone,
	"index_cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "markets_market_id_unique" UNIQUE("market_id")
);
--> statement-breakpoint
CREATE TABLE "ops_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"game_id" text,
	"market" text,
	"sig" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_points" (
	"market" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"price" double precision NOT NULL,
	CONSTRAINT "price_points_market_ts_pk" PRIMARY KEY("market","ts")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redeems_claims" (
	"sig" text NOT NULL,
	"ix_index" smallint NOT NULL,
	"market" text NOT NULL,
	"wallet" text NOT NULL,
	"kind" text NOT NULL,
	"usdc_amount" bigint NOT NULL,
	"yes_delta" bigint NOT NULL,
	"no_delta" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	CONSTRAINT "redeems_claims_sig_ix_index_pk" PRIMARY KEY("sig","ix_index")
);
--> statement-breakpoint
CREATE TABLE "resolution_drafts" (
	"game_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"home_score" integer NOT NULL,
	"away_score" integer NOT NULL,
	"periods" jsonb NOT NULL,
	"source_url" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"alerted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsor_log" (
	"sig" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"ip_hash" text NOT NULL,
	"lamports" bigint NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sponsored_atas" (
	"ata" text NOT NULL,
	"wallet" text NOT NULL,
	"mint" text NOT NULL,
	"created_sig" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone,
	"closed_sig" text,
	"closed_at" timestamp with time zone,
	"closed_to" text,
	CONSTRAINT "sponsored_atas_ata_created_sig_pk" PRIMARY KEY("ata","created_sig")
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"sig" text NOT NULL,
	"ix_index" smallint NOT NULL,
	"market" text NOT NULL,
	"wallet" text NOT NULL,
	"direction" text NOT NULL,
	"usdc_amount" bigint NOT NULL,
	"usdc_delta" bigint NOT NULL,
	"yes_delta" bigint NOT NULL,
	"no_delta" bigint NOT NULL,
	"fee" bigint NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	CONSTRAINT "trades_sig_ix_index_pk" PRIMARY KEY("sig","ix_index")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"pubkey" text PRIMARY KEY NOT NULL,
	"nickname" text,
	"nickname_sig" text,
	"kind" text DEFAULT 'human' NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_snapshots" ADD CONSTRAINT "game_snapshots_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resolution_drafts" ADD CONSTRAINT "resolution_drafts_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "games_tipoff_idx" ON "games" USING btree ("scheduled_tipoff");--> statement-breakpoint
CREATE INDEX "markets_game_idx" ON "markets" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "markets_status_idx" ON "markets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ops_events_ts_idx" ON "ops_events" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "claims_wallet_idx" ON "redeems_claims" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "sponsor_log_ts_idx" ON "sponsor_log" USING btree ("ts");--> statement-breakpoint
CREATE UNIQUE INDEX "sponsored_atas_open_idx" ON "sponsored_atas" USING btree ("ata") WHERE "sponsored_atas"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "sponsored_atas_wallet_idx" ON "sponsored_atas" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "trades_wallet_idx" ON "trades" USING btree ("wallet");--> statement-breakpoint
CREATE INDEX "trades_market_time_idx" ON "trades" USING btree ("market","block_time");