CREATE TABLE "market_id_reservations" (
	"game_id" text NOT NULL,
	"kind" smallint NOT NULL,
	"market_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_id_reservations_game_id_kind_pk" PRIMARY KEY("game_id","kind"),
	CONSTRAINT "market_id_reservations_market_id_unique" UNIQUE("market_id")
);
--> statement-breakpoint
ALTER TABLE "market_id_reservations" ADD CONSTRAINT "market_id_reservations_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE no action ON UPDATE no action;