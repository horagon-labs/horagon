# Game-night runbook

Play-money on devnet. No real value. No prizes.

Times are UTC. `<ET date>` is the NBA game date (Eastern time, `YYYY-MM-DD`), and S is a game's
scheduled tip-off. Every command and alert below comes from the code at this commit: the
keeper (`apps/keeper/src`), `horagon-ops` (`apps/keeper/src/ops`) and the units in
`ops/systemd`. `apps/keeper/test/runbook.test.ts` fails when an alert key the code can send is
missing from the alert table below, or when this runbook names one it never sends (in the table
or in backticks anywhere else).

## Before you start

`horagon-ops` runs on your machine, from the repository, with the keys and variables it needs:

```bash
# Once per shell, from the repo root. `.env` holds the "Shared" and "horagon-ops" parts of
# .env.example (git-ignored, never committed).
set -a; . ./.env; set +a
alias horagon-ops='pnpm --filter @horagon/keeper ops'
horagon-ops help          # prints the usage (so do --help and -h)
```

- `pnpm --filter @horagon/keeper ops <command> [flags]` passes the flags through as typed. The
  form with a separator, `... ops -- <command>`, works too: the CLI drops a leading `--`.
- pnpm prints the script line (`> tsx src/ops/cli.ts ...`) first. When the command fails it
  ends with `Exit status <n>`: `1` is an error or a refusal, `3` means a transaction may still
  land (procedure B).
- Guardian commands (`propose`, `challenge`, `halt`) sign with `.keys/guardian.json`; admin
  commands (`init-config`, `pause`, `resume`, `fund-authority`) with `.keys/deployer.json`.
  `--keypair <path>` picks another file; a relative path starts at the repo root.
- `status`, `propose`, `challenge` and `halt` need the keeper environment: `DATABASE_URL`,
  `HORAGON_RPC_URL` (and `HORAGON_CLUSTER` unless it is `devnet`); `propose` also needs
  `HORAGON_PUBLIC_URL`, the https site the evidence URI points to. Without `HORAGON_RPC_URL`,
  `status` still lists the games, but a propose line that needs the chain reads
  `pending check: may still land` (it fails closed).
- `flag` needs only `DATABASE_URL` (procedure I).
- `backfill-bot-memo` needs `DATABASE_URL` and `HORAGON_RPC_URL` (and `HORAGON_CLUSTER` unless
  it is `devnet`). It reads again from chain each trade indexed before trades.bot_memo existed,
  and records whether its transaction carries the horagon:bot memo. Run it after the keeper that
  writes the column is deployed, until it reports 0 left, before the metrics flag goes on; run it
  again after any rollback and redeploy of the keeper. It can run again at any time: it reads only
  the transactions still unset, and stops at the first one the RPC cannot return, keeping what it
  wrote.
- With `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set (both or neither), `horagon-ops` sends
  its own `tx:` and `tx-unresolved:` alerts to the same chat.

The keeper and the watchdog run on the VPS as systemd user units of the user `horagon`.
`HORAGON_VPS` below holds your SSH host alias for it (`ops/deploy-keeper.sh` reads the same
variable):

```bash
ssh "$HORAGON_VPS" systemctl --user status horagon-keeper
ssh "$HORAGON_VPS" journalctl --user -u horagon-keeper -f -o cat
ssh "$HORAGON_VPS" journalctl --user -u horagon-keeper -o cat --since -1h | grep '"msg":"alert"'
```

Telegram messages start with `[devnet]` and carry the alert text only. Each text is listed in
the alert table; the key itself is in the keeper's `alert` log line (the last command above).

## What lives where

| What                                       | Where                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keeper code                                | The VPS, `~/horagon` (a tarball of the deployed commit; `~/horagon/REVISION` names it)                                                                                                                                                                                                                                                                         |
| Keeper variables                           | The VPS, `~/horagon/.env.keeper` (`chmod 600`), read by both units                                                                                                                                                                                                                                                                                             |
| Agent key (the reference agent's wallet)   | The VPS, `~/horagon/.keys/agent.json` (`chmod 600`), and nowhere else; procedure J                                                                                                                                                                                                                                                                             |
| Attestor key (the keeper's signer)         | The VPS, `~/horagon/.keys/attestor.json` (`chmod 600`), and nowhere else                                                                                                                                                                                                                                                                                       |
| Elo ratings and model sigma                | The VPS, `~/horagon/apps/keeper/data/elo.json` (copied by hand, `docs/deploy.md`); the keeper does not start without it. Sigma, the in-game model's spread, is the measured standard deviation of the home margin over the 2025-26 season: 16.5                                                                                                                |
| Raw ESPN archive                           | The VPS, `~/horagon/apps/keeper/data/archive/<ET date>.ndjson`; gzipped after 2 days, deleted after 30                                                                                                                                                                                                                                                         |
| Units                                      | The VPS, `~/.config/systemd/user/`: `horagon-keeper.service`, `horagon-watchdog.service`, `horagon-watchdog.timer`, `horagon-agent.service` (copied from `ops/systemd` by every deploy)                                                                                                                                                                        |
| Admin and guardian keys                    | Your machine, `.keys/deployer.json` and `.keys/guardian.json`                                                                                                                                                                                                                                                                                                  |
| Web app and API v1                         | Vercel; the sponsor key is its `SPONSOR_SECRET_KEY`                                                                                                                                                                                                                                                                                                            |
| Database                                   | Supabase Postgres (`DATABASE_URL`)                                                                                                                                                                                                                                                                                                                             |
| `keeper_heartbeats` row `keeper`           | Written by the keeper after every round (5 s): `round`, `actions`, `feed` and the failure streaks `failing.tick` and `failing.index`. `status` prints it; `/api/v1/health` reads its age                                                                                                                                                                       |
| `keeper_heartbeats` row `agent`            | Written by the reference agent after every round (20 s), paused ones too: its round count, dry run or not, paused or not (and until when), the markets it read and the ones it decided, `cut` when the round ended early (`stale`, `stop` or `pause`; null when it decided them all), the swaps it sent, the markets it disabled; `stopped` after a clean stop |
| `keeper_heartbeats` row `watchdog`         | The time of the watchdog's last `heartbeat` page (`pagedAt`), so a new watchdog run knows when it paged                                                                                                                                                                                                                                                        |
| `keeper_heartbeats` row `propose:<gameId>` | The `propose` attempts of one game: the evidence hash, the challenge round, and how each send ended. `status` prints the newest one                                                                                                                                                                                                                            |

## The day before (by 05:00 UTC)

1. `horagon-ops status --date <ET date>`: the games whose tip-off falls in the 48 h from 00:00 UTC
   of that date (without `--date`: from 12 h ago), by tip-off, with `featured` on the featured
   ones and `no market` until S − 60 min. The first line is the keeper heartbeat.
2. Featured games (at most 4 a date; every market seeds 1,000 mUSDC with the deployed
   `SEED_REGULAR_USDC=1000`, the same as a featured game's seed): the hourly schedule pass
   picks them once per date. To change them: `horagon-ops featured <ET date> <gameId>...` (1 to
   4 ids; it replaces that date's choice, and the schedule pass keeps it). The seed is taken
   when the market is created, so change them before S − 60 min.
3. Treasury: every hour the keeper claims 1,000 mUSDC from the faucet for the attestor wallet
   and moves the attestor's mUSDC into the treasury, up to the seeds of the next 36 h + 20 %.
   With the deployed seeds (1,000 for every market), a night of N games needs N × 1,000 × 1.2
   mUSDC: 13,200 for the 11 games of ET 2026-11-27, 14,400 for 12. The code defaults (1,000
   featured, 300 for the others) would need 7,680 for a 12-game night. Each hourly pass moves
   at most what the attestor holds, so check the treasury and the attestor's balance together. If
   `treasury-low` came in, add mUSDC to the attestor wallet (claim the faucet for another wallet
   you control and transfer it); the next hourly pass moves it (a restart moves it at once: H).
4. SOL:
   - The Authority PDA pays 0.036 SOL of rent per market; `sol-authority` fires under
     2 × max(next night's games still without a market, 4) × 0.036 SOL. Top it up with
     `horagon-ops fund-authority <sol>` (signs with `.keys/deployer.json`, at most 10 SOL a call).
   - The attestor wallet pays the keeper's fees; `sol-keeper` fires under 0.2 SOL.
   - The sponsor pays players' fees and token-account rent; keep 1 to 2 SOL there.

## 30 minutes before the first tip-off

- `ssh "$HORAGON_VPS" systemctl --user status horagon-keeper` shows `active (running)`.
- `curl -s "$HORAGON_PUBLIC_URL/api/v1/health"` answers `"ok":true`, with
  `keeper.heartbeatAgeSecs` at a few seconds (one round is 5 s; `ok` turns false above 120 s).
- The first games have markets (`status` shows `market:open`; they open at S − 60 min): open
  `/` and one game page.

## During the night

Markets trade through the game and close at the final buzzer: the keeper halts a market on its
first Final read. The on-chain `end_ts = S + 3h00m` is only the latest close; over the 268 games
measured, 5 were still being played then and closed early. Nothing halts a market at tip-off.
The keeper halts a market that is still open (a halt withdraws all of Horagon's liquidity and
cannot be undone) on the first of:

- a Final read before `end_ts` (`final-before-end`), the normal close: ESPN showed Final 25 to
  148 s after the buzzer on the recorded night, and the keeper reads it every 15 s;
- the feed showing the game postponed or canceled (`postponed`);
- the game not started 24 h after S (`not-started`);
- no feed read for 10 min while the feed last showed Q4 or overtime (`feed-silent`).

After 2 min without a feed in Q4 or overtime it only alerts (`feed-silent-q4:`). From S + 1h40m
(80 min before `end_ts`, and before any measured game reached Q4) it also alerts on 2 min without
a feed whatever quarter the feed last showed, and at once for a game it has not read since it
started (`feed-silent:`): an outage that begins in Q3 would otherwise hide Q4. That alert never
halts.

Once ESPN has shown Final with the same score for 60 s, the keeper drafts the result and sends
`draft:`. With auto-propose on (`KEEPER_AUTO_PROPOSE`, procedure K), the keeper asks balldontlie
for the same game and, from the later of Final held 60 s and `end_ts`, the attestor proposes the
draft itself: `draft:` then says `Auto-propose from <time>` and there is nothing to do unless a
page comes. It holds a result balldontlie contradicts (`source-held:`), proposes without a
second source when balldontlie has no final 10 min after that time or no key is set (a `CHECK`
page), and pages `source-mismatch:` when balldontlie contradicts a proposal still inside its
window. A guardian proposes by hand (procedure A) only a held result, a postponed game, a game
after a challenge, or every game while auto-propose is off or dry. The keeper finalizes once
the dispute window (15 min with the default `--window 900`) has passed, then recycles. `status`
then shows `market:finalized`, then `market:recycled`.

## Procedures

### A. Propose a Final

The fallback: with auto-propose on, the keeper proposes a Final itself (K). Propose by hand a
result it held (`source-held:`), a game after a challenge (C), any game an `unconfirmed:` page
names, and every game while auto-propose is off or dry (its `draft:` then prints the command).

1. On `draft:<gameId>:<count>`, open the game's box score on nba.com or basketball-reference.com
   (espn.com is accepted with a warning: it is the feed itself) and check the final score
   against the alert. `draft:` and `status` show the score away-home, like `AWAY@HOME`, while
   `periods:` and `tie:` print it home-away after `AWAY@HOME`. `--score` takes home-away, so
   copy the command line the `draft:` alert prints.
2. Run it:
   `horagon-ops propose <gameId> --box-score <url> --score <home>-<away>`.
   - It refuses before `end_ts`: `proposing opens at end_ts <time>`. Run it again after that
     time. This is the usual case: markets close at the buzzer, and a game of median length ends
     about 28 min before `end_ts` (S + 3h00m). Its market stays halted meanwhile. A `draft:`
     sent before `end_ts` already gives that time, in UTC and ET (`proposing opens at ...`).
   - It refuses a score that differs from the draft (`box score <h>-<a> differs from the draft
     ...`). When the box score is right and ESPN is wrong, add
     `--periods <home>-<away>,<home>-<away>,...` (each period, overtime included, 4 to 12; they
     must add up to `--score`). Your reading then replaces the keeper's draft.
   - Success prints `proposed YES|NO for AWAY@HOME (<signature>)` and
     `evidence <uri>  sha256 <hash>`.
3. If it ends with exit status 3 (`unknown: ... may still land`), or refuses because the stored
   evidence was sealed from other inputs, follow B.
4. The result finalizes after the dispute window. A wrong result before then:
   `horagon-ops challenge <gameId>`, then C.

`--periods` is required whenever the keeper has no draft (`periods:`, `tie:`, `no-feed:`,
`stuck:`, or after a challenge before the keeper drafts again): without it `propose` refuses with
`no pending draft (keeper writes one 60 s after a stable Final)`.

### B. A propose that may still land, and `--replace-evidence`

Every `propose` records its attempt (the evidence hash and the challenge round) before it sends,
then how it ended (the signature, and the block height when it ended unresolved). A re-run never
publishes evidence whose hash the chain may not hold:

- A re-run with the same inputs sends the evidence already stored (it prints `sending the
  evidence an earlier propose stored (sha256 ...)`). This is the safe retry after exit status 3.
- A re-run with different inputs (score, periods, box-score URL, notice, or a new keeper draft)
  is refused with exit status 1: `the stored evidence (sha256 ...) was sealed from other inputs
  ...`. After a challenge this refusal is expected (C).

Steps:

1. After exit status 3, look the printed signature up (Solana Explorer, devnet) and run
   `horagon-ops status --date <ET date>`. Do not change the inputs yet.
2. Find the game's line and the line under it:
   `propose attempt: <sending|sent|ended>  sig <first 8>...<last 4>  round <n>  pending check: <verdict>`.
   The signature is shortened: take the full one from the propose output. Two other forms:
   `propose record: no attempt  round <n>  pending check: <verdict>` (a record without a send),
   and `propose record: unreadable  pending check: may still land` (the record does not parse;
   it fails closed, so `--replace-evidence` stays refused, while a re-run with the same inputs
   is still safe).
3. `market:proposed` on the game's line: a propose landed. Nothing to do, unless it is the wrong
   result (challenge, then C).
4. `pending check: may still land`: an attempt can still land. Wait and run `status` again;
   re-running the same command meanwhile is safe.
5. `pending check: expired`: nothing sent earlier can land. Re-run with the new inputs and
   `--replace-evidence`. While it cannot tell, `--replace-evidence` refuses and says why
   (`... may still land until block height <n>` or `until <time>`).
6. `pending check: landed`: an attempt landed; run `status` again in a few seconds, once the
   keeper has synced the market.

How long an attempt counts as "may still land": until the chain is 200 blocks past the height
read when it ended unresolved (about a minute); 5 min after it ended when no height was read;
15 min after it started when it never recorded its end (the command was killed).

### C. After a challenge

1. `challenge:<gameId>:<count>` says `Challenged: AWAY@HOME. Re-check and propose again.` (from
   your `challenge` or another guardian's). The keeper marks the draft rejected and drafts again
   from the feed: a new `draft:<gameId>:<count>` follows once ESPN's Final has held 60 s.
2. Check the box score again, then propose: as in A with the keeper's new draft, or right away
   with your own `--periods`. After a challenge the keeper never proposes the game itself, so
   this step is always yours.
3. `<gameId>: no pending final draft to propose; run status` (or `postponed`): the draft is
   still marked proposed because the keeper has not seen the challenge yet. Run `status` until
   the game shows `draft:final/rejected` or a new `draft:final/pending`, then propose again. (On
   `market:proposed`, a propose has landed: nothing to do.)
4. Refused because the stored evidence was sealed from other inputs: expected, the stored
   evidence is the challenged one. Follow B from step 2. An attempt of the challenged round that
   may still land holds `--replace-evidence` back until it expires (about a minute); one that
   landed does not.
5. The second form of the alert, `... was challenged and has been re-proposed (now <status>).
   Check the new proposal.`, means a new proposal is already on chain: check it with `status`.

### D. Postponed, canceled or not played

- The keeper halts the market as soon as the feed shows the game postponed or canceled, or when
  it has not started 24 h after S (`halt:<gameId>`).
- A game played within 7 days of its original tip-off resolves on that game: the keeper follows
  the feed and drafts its Final as usual.
- 7 days after the original tip-off, with the feed still showing it not played, the keeper
  drafts NO: `draft:<gameId>:<count>` says `was not played within 7 days. Resolve NO`. Propose:
  `horagon-ops propose <gameId> --postponed --notice <league notice url>` (https, at most 256
  characters, no port).
- `propose --postponed` also works before the 7 days, from the notice alone; use it only when
  the league says the game will not be played within them.
- `no-feed:<gameId>`: no feed for the game at all 7 days after tip-off. Played: propose as in A
  with `--periods`. Not played: propose with `--postponed --notice`.

### E. Evidence mismatch

`evidence-mismatch:<gameId>`: the evidence hash on chain differs from the evidence the API
serves (`/api/v1/evidence/<gameId>/winner`), so nobody can verify the result. The keeper checks
whenever it syncs a market that has a hash on chain, and repeats the alert at most every 3 h:
silence is not proof that it is fixed.

1. `horagon-ops status --date <ET date>`: note the market state and the propose line.
2. Open the served evidence and check its score and `outcome` against the box score.
3. Market `proposed`, inside the dispute window: `horagon-ops challenge <gameId>`, then C. The
   new proposal carries the hash of the evidence that is stored and served, which `propose`
   prints (`evidence <uri>  sha256 <hash>`).
4. Market already `finalized` or `recycled`: the result stands on chain and cannot be
   re-proposed. Record the game, both hashes and the time in the night's notes.

### F. Halt by hand

When a feed shows something wrong while the market is open, or a `feed-silent` alert comes
and the game may end before `end_ts` (the keeper cannot halt at the buzzer without a feed):
`horagon-ops halt <gameId>`. It withdraws all of Horagon's liquidity; it cannot be undone, and
the market stays halted until its result is proposed. A market that is not open prints
`<gameId> is already <status>; nothing to halt`.

### G. Stop and restart the keeper

```bash
ssh "$HORAGON_VPS" systemctl --user restart horagon-keeper
```

- The keeper exits by itself when nothing has happened for `KEEPER_STALL_SECS` (default 120 s;
  no step, heartbeat, log line or RPC answer, as when a database response is lost; the check runs
  every 15 s, so it fires 120 to 135 s after the last sign of life), logging
  `keeper stalled: exiting so the service restarts` at fatal; systemd restarts it after 5 s. ESPN
  fetches do not count as activity and the schedule step can be silent for about 70 s in the
  worst case, so a value under about 90 can fire falsely on a healthy keeper.
- A stop (SIGTERM) ends the round after the step in progress. The unit waits up to 120 s
  (`TimeoutStopSec`): one transaction wait (90 s) plus an RPC timeout. A step that holds
  several sends can take longer and is then killed. A second SIGTERM exits at once.
- Avoid restarting from S + 1h40m until a game's market is halted at the buzzer (or its
  `end_ts`, S + 3h00m, has passed): a stop holds back halts until the new process runs, and the
  new process alerts `feed-silent:` until its first feed read (below). A deploy checks this
  itself: `ops/deploy-keeper.sh` runs `horagon-ops deploy-check` on the VPS and refuses while a
  game is between tip-off - 60 min and its market's close, unless given `--force`.
- The next start checks every RPC's cluster, then re-plans every action from chain state: work
  that landed is seen on chain and not repeated. (`isDone` is asked only between the retries of
  one send, not across a restart.) A transaction in flight when the keeper stopped may land
  after the new process read the chain, which then sends the same action again: the chain
  refuses one of the two (create, halt, propose, finalize, recycle), and when it refuses the new
  one it arrives as `fail:<action>:<gameId>`. That is expected once `status` shows the effect. A
  treasury top-up can land twice (accepted: play money, inside the project's own accounts). Of
  the keeper's own sends, only an auto-propose keeps an attempt record, as `horagon-ops propose`
  does (B); a retry after the restart sends the evidence it stored.
- The first round after a start also runs the hourly steps (schedule, treasury, archive
  retention), and the alerter has forgotten what it sent, so open alerts come again.
- From S + 1h40m until its market closes, a game the keeper has not read since the start (ESPN
  not answering) alerts `feed-silent:` at once, until a feed read includes it. The feed is read
  every 15 s.
- `fund-authority` is the one command with no `isDone` check. After it ends with exit status 3,
  look the printed signature up before running it again, or it sends the SOL twice. (`status`
  does not show the Authority's balance.)

### H. Fill the treasury now

`treasury-empty:<gameId>` means the keeper cannot seed that game's market inside its create
window (S − 60 min to S + 30 min, while the game has not started). The hourly treasury step may
come too late, so:

1. Put mUSDC in the attestor wallet: claim the faucet for a wallet you control and transfer it
   there (the keeper already claims for the attestor every hour, and the faucet pays a wallet
   once an hour).
2. Before S, restart the keeper (G), unless another game is past S + 1h40m and still open.
   The first round after a start runs the treasury step, which moves the attestor's mUSDC into
   the treasury up to the seeds of the next 36 h's games without a market, + 20 %; the round
   after it creates the market. That step counts only games whose tip-off is still ahead, so
   after S use step 3.
3. Or transfer the seed straight to the treasury, the Authority's mUSDC account, from any wallet
   that holds mUSDC (the account exists once the keeper's first top-up has run). Its address,
   for the default mint:

   ```bash
   pnpm --filter @horagon/keeper exec tsx -e "import { DEVNET_MUSDC_MINT, HoragonProgram } from '@horagon/sdk'; console.log(new HoragonProgram({ collateralMint: DEVNET_MUSDC_MINT }).treasury.toBase58())"
   ```

The keeper tries the create again every round, so the market opens within seconds of the
treasury holding the seed: 1,000 mUSDC for every game with the deployed `SEED_REGULAR_USDC`
(the code default for a non-featured game is 300). A market is created only when the treasury
holds its whole seed: below it the keeper alerts `treasury-empty` and creates nothing.

### I. Turn a feature off

The database holds ten flags, and every flag starts off: `FLAG_ME`, `FLAG_METRICS`,
`FLAG_METRICS_COHORT`, `FLAG_SHARE`, `FLAG_RANK`, `FLAG_CREWS`, `FLAG_TELEGRAM`, `FLAG_CLUTCH`,
`FLAG_PRACTICE` and `FLAG_VERIFY`. A route guarded by `requireFlags` answers 404
(`application/problem+json`) while its flag is off, POST routes too, and the API reads the flags
on every request, so a change applies at once, with no deploy and no restart.

At this commit one flag is read. `FLAG_ME` guards My Game-day: `GET /api/v1/me/{wallet}`
answers 404 while it is off, and `GET /api/v1/positions/{wallet}` carries the nights field only
while it is on. The header's night chip and the wallet sheet's "My Game-day" link show only when
that field is there, so with the flag off no page links `/me`, and `/me` itself says "My
Game-day is switched off right now." Turning it on is a controller step after the deploy. No
other route or page reads a flag, so the other nine change nothing a player sees. In particular
the Share button and the per-game OG card are not behind a flag: if the OG route misbehaves on a
night, the switch is a deploy (or a rollback of the web), not a flag. A feature that ships with a
guard documents its flag here.

The command, for a flag that a route does read:

```bash
horagon-ops flag off <FLAG_NAME>
horagon-ops flag on <FLAG_NAME>
```

It prints every flag with its state and logs the change in `ops_events` (actor ops, action
flag). `GET /api/v1/flags`, `POST /api/v1/tx/trade` and the Tier 1 game routes have no flag.

### J. The reference agent

The reference agent is a disclosed team wallet that trades toward the model on live winner
markets when no other wallet has traded for 90 s (README, "Reference agent"). It is its own
process, `apps/keeper/src/agent-main.ts` as the unit `horagon-agent.service`, with its own key
(`~/horagon/.keys/agent.json`), and reads the same `.env.keeper`. Its wallet must be listed as a
team-burner in `docs/metrics-wallets.json`, in a public commit, before its first swap. Every swap
carries the horagon:bot memo; its claims carry none. The agent checks that listing itself when
it starts, in a dry run too: when the shipped `docs/metrics-wallets.json` is missing, unreadable
or does not list its wallet as team-burner, it alerts `agent-unlisted`, logs
`agent wallet is not listed as team-burner in docs/metrics-wallets.json` and exits 0 before it
reads the chain or the database.

A deploy installs the unit but never enables, starts or restarts it. A running agent keeps the
previous revision, and the deploy prints `horagon-agent: active, still running the previous
revision`: restart it by hand to run the new one (below). Start, watch, restart and stop it by
hand:

```bash
ssh "$HORAGON_VPS" systemctl --user start horagon-agent
ssh "$HORAGON_VPS" journalctl --user -u horagon-agent -f -o cat
ssh "$HORAGON_VPS" systemctl --user restart horagon-agent
ssh "$HORAGON_VPS" systemctl --user stop horagon-agent
```

- **After a deploy.** `systemctl --user restart horagon-agent` picks up the new revision. A
  restart by hand also clears the markets its anomaly check stopped and its own spend count (the
  trades table still holds the spend the indexer has seen), so look at `agent-anomaly:` alerts of
  the night first.

- **Dry run first.** It runs dry unless `.env.keeper` sets `AGENT_DRY_RUN=0`: with
  `AGENT_DRY_RUN=1` (the default) it logs every decision and sends nothing (no swap, no claim, no
  faucet claim). A line `agent swap` carries the market, the price, the model, the gap, the side,
  the size in mUSDC and the expected price after it; a line `agent skip` carries the reason. Set
  `AGENT_DRY_RUN=0` and restart to trade.
  - There is no rehearsal before night 1: night 1 is the dry run. Read the `agent swap` and
    `agent skip` lines of its first live markets before you set `AGENT_DRY_RUN=0`.
  - An empty or low wallet does not hide them. When the wallet holds less than the agent's spend
    cap (`AGENT_MAX_PER_GAME` for each market the round read: 2,000 mUSDC each by default), a dry
    run plans against that cap instead, and each decision line carries `notional: true`.
  - A dry run never pages `agent-musdc`. Instead it logs this line, at most once an hour:
    `agent: dry run, the wallet holds under AGENT_MIN_MUSDC; no page in a dry run, which plans against its spend cap`.
  - A live run reads its real balance and claims the faucet itself, every hour from its first
    round, before it trades.
- **Kill switch.** `systemctl --user stop horagon-agent` ends the round in progress: a send in
  flight completes (up to 120 s), no new swap or claim starts, and it stops, writing `stopped` in
  its heartbeat. Set `AGENT_ENABLED=0` (or remove the line) in `.env.keeper` as well: any
  start then logs `agent disabled` and exits 0, and the unit stays down. The unit is not enabled,
  so a VPS reboot does not start it.
- **A market disabled by an anomaly** stays disabled until the agent is restarted by hand:
  `systemctl --user restart horagon-agent`. A deploy never restarts it. A crash or a stall exit,
  which systemd restarts on its own, keeps it disabled: at start the agent reads its last
  heartbeat, and when that row has no `stopped` it disables the markets listed there again (log
  line `agent: the markets disabled before an unplanned restart stay disabled`). A stop by hand
  that did not end cleanly leaves no `stopped` in that row either, so the next start keeps the
  markets off: restart it once more. That happens when systemd killed it after 120 s, when a
  second signal made it exit at once (code 130), or when its last heartbeat was not written (log
  line `agent heartbeat not written`).
  - The check holds first. The agent reads other wallets' trades from the indexer, which stores
    a trade a keeper round after it lands at best (5 s), and 90 s or more later while the keeper
    waits on a send. So when the read after a swap finds the gap grown and no trade by another
    wallet since the swap is stored, the market is held for 2 min: skip reason `held`, no swap,
    no page, and the log line
    `agent: the price moved away from the model after its swap, and no other trade is stored yet; market held`.
  - A trade by another wallet at or after the swap, stored before the hold ends, clears the check
    (log line `agent: another wallet traded after its swap; check cleared`): the market stays
    enabled and nothing pages, so one counter-trade cannot switch the agent off a market.
  - A gap still grown at the end of the hold, with no such trade stored, disables the market and
    pages `agent-anomaly:`. An indexer more than 2 min behind the chain can still let a
    counter-trade do that; `index-stuck:` pages only after about 5 min.
- **A pause** (5 failed reads or sends in a row, `agent-paused`) lasts `AGENT_PAUSE_SECS`
  (600 s), counted from the failure that started it: after a send that took 90 s, from its end.
  It reads and sends nothing meanwhile, but goes on writing its heartbeat every round
  (`paused: true` and `pausedUntil` in the `agent` row) and stays alive: a pause never trips the
  stall exit.
- **Limits** (defaults, all in `.env.example`): at most 100 mUSDC a swap, 2,000 mUSDC and 40
  swaps per market, one swap per market per 20 s round, nothing within 120 s of a market's
  `end_ts` (S + 3h00m) or while the model is over 60 s old. It never sells. Its spend and swaps
  per market come from the trades table and from its own count, whichever is larger, and one
  round never plans more than the wallet held when the round read it. A round decides every
  market on one read, taken after the hourly faucet and claims; once that read is older than half
  an interval (10 s, a slow send), the round ends (`agent round cut short`, and `cut: 'stale'` in
  the `agent` row) and the markets left wait for the next round's read. Each round starts at the
  market after the last one decided, wrapping around, so the markets late in the list (by
  `end_ts`, then address) get their turn on a busy night.
- **The horn.** At the end of Q4 or an overtime, ESPN shows the game still live with 0 s on the
  clock for up to about two minutes before Final, and the model already reads 0 or 1. The agent
  skips a game that reads period 4 or later at 0 s (skip reason `horn`), so it never buys a
  decided game before the keeper halts its market on the Final read.
- **When it cannot run.** A start that fails (a bad `AGENT_*` line, the key file, the cluster
  check, a database that does not answer), or a loop that ends on an error, logs
  `agent failed to start: ...` (or `agent stopped on an error: ...`), pages `agent-down` and
  exits 1. systemd starts it again 10 s later, up to 5 starts in 10 min, then leaves it down.
  The page goes out once in those 10 min: each start is a new process, so the time of the last
  page is kept in `apps/keeper/data/agent-down.json`. Fix the cause, run
  `systemctl --user reset-failed horagon-agent`, then start it.
- **Slow reads.** When the read itself takes over 10 s (a degraded RPC or database), every round
  is cut before its first decision and the agent trades nothing. From the third such round in a
  row it logs `agent: rounds cut before their first decision, the reads are slow` (a warning, at
  most every 10 min). Nothing is wrong with the markets: check the RPC and the database, which
  the keeper uses too; the agent goes on by itself once the reads are fast again.

### K. Auto-propose and its pages

The keeper's attestor proposes a Final itself, checked against balldontlie, a second score
source. A guardian then only answers its pages. The settings, in `~/horagon/.env.keeper`
(restart the keeper after a change, G):

- `KEEPER_AUTO_PROPOSE`: `on` (the default), `dry` or `off`. A dry run decides as `on` does and
  pages `DRY RUN: would propose ...` once per game and challenge round; it sends nothing and
  writes no evidence, draft state or attempt record. Run the first night after the deploy that
  brings auto-propose as `dry`, check its pages against your own box-score checks, then set
  `on`.
- `HORAGON_PUBLIC_URL`: the https site the evidence URI points to (the one `horagon-ops propose`
  uses). Unset, or not usable for a URI of at most 128 characters, the mode is `off` whatever
  `KEEPER_AUTO_PROPOSE` says: the keeper still starts and pages `auto-propose-off`.
- `BALLDONTLIE_API_KEY`: the free-tier key, sent in a header only and never logged. Unset or
  blank, there is no second source and every proposal is a `CHECK` page. A key balldontlie
  refuses (HTTP 401 or 403) pages `second-source-refused`.
- Without `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, the keeper logs a warning at start: its
  pages reach the journal only.
- `KEEPER_TIMINGS` may set `secondSourceWaitSecs` (default 600): how long it waits past the
  propose time for a silent balldontlie before it proposes without it.

It proposes an NBA game whose draft is a pending Final of challenge round 0, on a market open or
halted on chain, while ESPN still shows Final at the draft's score with periods that add up. The
propose time is the later of Final held 60 s and `end_ts`; a chain clock still before `end_ts`
is a skip, tried again next round, never a `fail:` page. It asks balldontlie at most once a
minute per ET date, and not for 120 s after an HTTP 429, and only for games with such a draft or
with a proposal still inside its window. Each change of balldontlie's verdict on a game writes
one `ops_events` line (actor `keeper`, action `second-source`), and a proposal writes action
`propose` with actor `keeper`.

The pages and what to do:

- `auto-proposed:` that says `ESPN and balldontlie agree. Nothing to do.`: nothing to do. It
  gives the time the challenge window closes and the start and end of the evidence sha256.
- `auto-proposed:` that begins `CHECK`: no second source checked the result (no key, or no
  final from balldontlie 10 min after the propose time). Open the basketball-reference box score
  it links and compare the final score. If the proposal is wrong:
  `horagon-ops challenge <gameId>` before the time it gives, then C.
- An `auto-proposed:` page that Telegram did not take is sent again every minute while the
  window is open, also after a failure once the proposal landed, and once more after a keeper
  restart. Its check is the one its evidence on chain carries.
- `auto-proposed:` that begins `DRY RUN`: nothing was sent. Check the box score and propose by
  hand (A) with the command it prints.
- `source-mismatch:`: balldontlie's final differs from a proposal still inside its window.
  Check the box score. If the proposal is wrong, challenge before the time it gives, then C. If
  balldontlie is wrong, nothing to do: the result finalizes when the window closes.
- `source-held:`: the two sources disagree and nothing was proposed. Check the box score, then
  propose by hand (A): `--score` from the box score, and `--periods` when ESPN is the one that is
  wrong. If balldontlie comes to agree with ESPN first, the keeper proposes by itself. Only that
  ends the hold: a balldontlie that stops listing the game, or goes down, keeps it, and so does a
  keeper restart (the hold is kept in a `keeper_heartbeats` row per game).
- `unconfirmed:` with a cause (a dry run, a held result, a propose that keeps failing, and so
  on): propose by hand (A) with the command it prints.
- `fail:` for a propose: the program refused the attestor's proposal. The keeper tries again
  every round and names the error in `unconfirmed:` 30 min after the propose time.

The keeper seals the evidence once and records its attempt as `horagon-ops propose` does, so a
retry sends the stored evidence unchanged. After an auto-propose that did not land, a hand
propose with other inputs is refused because the stored evidence was sealed from other inputs:
follow B.

### L. Index reads rate-limited

The indexer reads the chain every 5 s and the ATA watch every 10 min, through one pace. A
rate limit on any of their reads (HTTP 429, or an RPC error saying "Too many requests") stops
that pass and pauses their reads: 30 s, doubling on each limit in a row up to 10 min, a little
less with jitter, and back to 30 s after a pass whose reads all answered. Each pause logs one
warning, `RPC rate-limited index reads; pausing them`, with its delay. Halts, proposals,
finalizes and the rest of the tick do not use these reads and keep their cadence.

Between pauses the indexer asks a market for its signatures only when its account changed since
it was last indexed, or when its sweep is due: 60 s for an open market, 5 min for the others
(claims and redeems do not change the market account, so the sweep is what finds them). Each
market is indexed once after a start. Signature reads are 200 ms apart, and a pass starts no
market after 3 s; the rest go first on the next pass.

When `index-rate-limited` pages (a pause over 15 min):

1. Wait. Nothing on chain is at risk, and the pause ends by itself once the RPC answers again;
   the next pass catches up every market from its cursor. A keeper restart does not help: it
   only starts the back-off over at 30 s.
2. If it lasts into a game night, set `HORAGON_INDEX_RPC_URL` in `~/horagon/.env.keeper` to an
   https devnet endpoint of a dedicated provider (a key in its URL is fine: the keeper logs the
   host only), check it by name only, and restart (G) outside the window G names. The keeper
   checks its cluster at start: a mainnet or wrong-cluster URL stops the start, one that does
   not answer is left out (`rpc-index-down`) and the main RPC takes the reads again. Leave it
   unset to read through `HORAGON_RPC_URL` as before.

## Alerts

One row per alert key. "Repeats" is the shortest gap between two messages with the same key
from one process: 10 min by default, and 3 h for the keys that wait on a person. A restart
forgets what was sent, each `horagon-ops` run is a process of its own, and a message that
Telegram did not take is tried again after 60 s. `<count>` is the market's on-chain challenge
count (0 before any challenge), so a new challenge round is never held back. `<label>` names the
transaction: `create <gameId>`, `halt <gameId> (<rule>)`, `propose <gameId>` (auto-propose),
`finalize <gameId>`, `recycle <gameId>`, `treasury top-up`, and from `horagon-ops`:
`propose <gameId>`, `challenge <gameId>`, `halt <gameId> (guardian)`, `initialize_config`,
`pause creation`, `resume creation`, `fund authority`, and from the reference agent:
`swap <gameId>`, `claim <gameId>`.

| Key                            | Telegram text begins with                                                                                                                                                               | Repeats           | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draft:<gameId>:<count>`       | `AWAY@HOME Final <away>-<home> (ESPN). Auto-propose from <time>`, or `... Check the box score` (with the time proposing opens), or `... was not played within 7 days. Resolve NO`       | 10 min            | Auto-propose from: nothing to do unless paged (K). Otherwise propose: A for a Final, from the time it gives (`end_ts`), D for NO                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `unconfirmed:<gameId>:<count>` | `AWAY@HOME: final draft not proposed 30 min after proposing opened: <cause>` (or `postponed draft`; with auto-propose off `... open to propose for 30 min`); from the draft or `end_ts` | once a draft      | Propose now (A or D) with the command it prints. The cause says why the keeper did not: a dry run, a postponed result, a round after a challenge, another league, a held result (`source-held:`), ESPN no longer Final at the draft score, or the error of a propose that keeps failing                                                                                                                                                                                                                                                                        |
| `auto-proposed:<id>:<count>`   | `Proposed YES for AWAY@HOME, Final <away>-<home> (ESPN). ESPN and balldontlie agree` (or `NO for`), or `CHECK: proposed ...`, or `DRY RUN: would propose ...`                           | once a proposal   | K (`<id>` is the game id). Agree: nothing to do. `CHECK`: check the box score it links and challenge before the time it gives if it is wrong. `DRY RUN`: nothing was sent, propose by hand (A). Until Telegram takes it the keeper tries again every minute, and it sends it once more after a restart while the window is open                                                                                                                                                                                                                                |
| `source-mismatch:<gameId>`     | `MISMATCH: AWAY@HOME balldontlie <away>-<home> vs proposed <away>-<home>. Challenge before <time>`                                                                                      | 10 min            | K: check the box score; if the proposal is wrong, `horagon-ops challenge <gameId>` before that time, then C. It repeats while the window is open                                                                                                                                                                                                                                                                                                                                                                                                               |
| `source-held:<gameId>`         | `HELD: AWAY@HOME ESPN <away>-<home> vs balldontlie <away>-<home>, nothing proposed`                                                                                                     | 3 h               | K: check the box score it links, then propose by hand (A, with `--periods` when ESPN is wrong). The keeper proposes by itself if the two sources come to agree                                                                                                                                                                                                                                                                                                                                                                                                 |
| `second-source-refused`        | `balldontlie refused BALLDONTLIE_API_KEY (HTTP <status>)`                                                                                                                               | 3 h               | The key is wrong, expired or revoked: every proposal is unchecked (`CHECK`) until it is fixed. Put a working key in `.env.keeper` (never in a chat or on a command line), then restart (G)                                                                                                                                                                                                                                                                                                                                                                     |
| `auto-propose-off`             | `Auto-propose is off (<reason>): propose every result by hand (runbook A).`                                                                                                             | once a start      | Every result waits for a guardian (A). To turn it on: `HORAGON_PUBLIC_URL` set and `KEEPER_AUTO_PROPOSE` not `off` in `.env.keeper`, then restart (G)                                                                                                                                                                                                                                                                                                                                                                                                          |
| `challenge:<gameId>:<count>`   | `Challenged: AWAY@HOME.`                                                                                                                                                                | 10 min            | C                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `evidence-mismatch:<gameId>`   | `Evidence mismatch: AWAY@HOME has sha256 ... on chain, but the API serves ...`                                                                                                          | 3 h               | E, before the dispute window closes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `periods:<gameId>`             | `AWAY@HOME: ESPN periods do not add up to <home>-<away>; resolve by hand`                                                                                                               | 3 h               | No draft. Propose with `--score` and `--periods` from the box score (A)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tie:<gameId>`                 | `AWAY@HOME: ESPN Final is tied <home>-<away>; resolve by hand`                                                                                                                          | 3 h               | No draft (an NBA game cannot end tied, so the feed is wrong). Propose with `--score` and `--periods` from the box score (A)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `no-feed:<gameId>`             | `AWAY@HOME: no feed 7 days after tip-off; resolve by hand`                                                                                                                              | 10 min            | D                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `stuck:<gameId>`               | `AWAY@HOME: market closed over 6 h ago with no result draft; resolve by hand`                                                                                                           | 3 h               | Check the box score; propose with `--periods` (A), or `--postponed --notice` (D)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `feed-silent-q4:<gameId>`      | `AWAY@HOME: no feed for <n> min in Q4/OT, market still open; the keeper halts at 10 min`                                                                                                | 10 min            | Watch the game on a live source. If it may end before `end_ts` and the feed is still down: `horagon-ops halt <gameId>` (F)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `feed-silent:<gameId>`         | `AWAY@HOME: no feed for <n> min, last seen ...`, or `... no feed read since the keeper started`                                                                                         | 10 min            | Same as `feed-silent-q4:`. This one never halts by itself                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `halt:<gameId>`                | `Halted AWAY@HOME: <rule>`                                                                                                                                                              | 10 min            | `final-before-end`: wait for `draft:`. `feed-silent`: check the box score; if the game is still on, nothing to do (the market stays halted until its result). `postponed`, `not-started`: D                                                                                                                                                                                                                                                                                                                                                                    |
| `no-p0:<gameId>`               | `AWAY@HOME: no p0, market not created`                                                                                                                                                  | 10 min            | The game's row has no pre-game probability, which the hourly schedule step writes for every game it reads. Look for a failing `schedule` step in the log. A market can still open while the game has not started, until S + 30 min                                                                                                                                                                                                                                                                                                                             |
| `treasury-low`                 | `Treasury <n> mUSDC, next 36 h needs <n>`, or `Treasury <n> mUSDC: <gameId> seeded at 300 instead of 1,000`                                                                             | 10 min            | Add mUSDC to the attestor wallet ("The day before", step 3). With the deployed seeds (1,000 for every game) the 300 fallback for a featured game never applies: below the seed no market is created                                                                                                                                                                                                                                                                                                                                                            |
| `treasury-empty:<gameId>`      | `Treasury <n> mUSDC: cannot seed <gameId>`                                                                                                                                              | 10 min            | No market for that game until the treasury holds its seed; the keeper retries every round while the game has not started, until S + 30 min. The hourly top-up may come too late: fill the treasury now (H)                                                                                                                                                                                                                                                                                                                                                     |
| `treasury-unread`              | `Treasury balance could not be read <n> times in a row`                                                                                                                                 | 3 h               | No market is created until the RPC answers. Check `HORAGON_RPC_URL` and the RPC provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `sol-authority`                | `Authority holds <n> SOL, under 2 nights of markets`                                                                                                                                    | 10 min            | `horagon-ops fund-authority <sol>` (G: check before repeating it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `sol-keeper`                   | `Keeper wallet holds <n> SOL; fees need 0.2`                                                                                                                                            | 10 min            | Send devnet SOL to the attestor wallet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ata-close:<wallet>`           | `Wallet <wallet> closed sponsor-paid ATA <ata>, rent to <address>`                                                                                                                      | 10 min            | The API opens no more token accounts for that wallet. A close that a traced claim_winnings made (YES or NO of its own user and market, rent to the player) never raises it and is recorded as "claim". The trace reads the account's signatures newest first back to its creation, over as many passes as heavy noise needs, and records "unknown" (and raises this alert) only when it reaches the creation without finding a close. Many in a night: lower `SPONSOR_ATAS_PER_IP_DAY` on Vercel, then redeploy                                                |
| `ata-trace:<ata>`              | `The close of sponsor-paid ATA <ata> (wallet <wallet>) is still being traced after <n> passes: heavy transaction noise on the account. The wallet is not flagged`                       | 3 h               | Noise on the account hides its close and the keeper keeps tracing it, 200 transactions per pass; nothing is flagged meanwhile. Check by hand: open the ATA address in an explorer (or `solana transaction-history <ata>`) and look for a CloseAccount, or a `claim_winnings` that closes it. If the rent went to the sponsor or to a claim, nothing to do (the trace ends by itself once it reaches the close). If it went to another address, the wallet is not blocked until the trace says so: lower `SPONSOR_ATAS_PER_IP_DAY` on Vercel if it is an attack |
| `external-lp:<market>`         | `External liquidity added to <gameId>; the pool is no longer Horagon's alone`                                                                                                           | 10 min            | Nothing to do: the game page shows it, and a halt withdraws only Horagon's share                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `fail:<action>:<gameId>`       | `<action> <gameId> rejected: ... error <name>`                                                                                                                                          | 10 min            | The program refused a keeper action (`create`, `halt`, `finalize`, `recycle`, `propose`). Read the error name and check `status`; the keeper plans it again every round. An auto-propose that keeps failing names its error in `unconfirmed:` 30 min after proposing opened                                                                                                                                                                                                                                                                                    |
| `tx:<label>`                   | `Transaction "<label>" failed 4 times (...); 1 attempt left`                                                                                                                            | 10 min            | Check the RPC (`HORAGON_RPC_URL`). The keeper plans the action again on the next round                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tx-unresolved:<label>`        | `<label>: unresolved after 90 s, <signature> may still land`                                                                                                                            | 10 min            | The transaction may still land: look the signature up before doing anything by hand. The keeper re-plans from chain state; for a `horagon-ops` command, B (propose) or G (`fund-authority`)                                                                                                                                                                                                                                                                                                                                                                    |
| `agent-anomaly:<gameId>`       | `Reference agent: after its YES swap on AWAY@HOME the price moved away from the model` (or `NO swap`)                                                                                   | 10 min            | The agent no longer trades that market until it is restarted by hand (a restart after a crash or a stall keeps it off, J); nothing else is affected. It held the market 2 min first, and no trade by another wallet since the swap was stored in that time: a wrong side or a swap that did something else is a bug, stop the agent (J). An indexer more than 2 min behind the chain can also cause it: look for `index-stuck:` and the trades of that market first. Restart it (J) to trade the market again                                                  |
| `agent-unlisted`               | `Reference agent not started: its wallet <pubkey> is not listed as team-burner in docs/metrics-wallets.json (<reason>)`                                                                 | once a start      | The agent exited 0 without trading. Add the wallet to `docs/metrics-wallets.json` as a team-burner in a public commit, deploy, then start it (J). A wrong `AGENT_KEYPAIR` shows here too: it must be the agent's own key                                                                                                                                                                                                                                                                                                                                       |
| `agent-down`                   | `Reference agent failed to start: <error>`, or `Reference agent stopped on an error: <error>`                                                                                           | 10 min (restarts) | It trades nothing until it runs again; the keeper is not affected. Read its log (J): a bad `AGENT_*` line, the key file or a cluster refusal (fix `.env.keeper`), or a database that does not answer (the keeper shows it too). systemd starts it again up to 5 times in 10 min, then leaves it down; this page goes out once in those 10 min. Fix the cause, `systemctl --user reset-failed horagon-agent`, then start it (J)                                                                                                                                 |
| `agent-paused`                 | `Reference agent paused 10 min after 5 failed reads or sends in a row`                                                                                                                  | 10 min            | It resumes by itself after the pause. Read the error in its log (J): an RPC or database outage also shows in the keeper (`tick-failing`); a refused swap names the program error                                                                                                                                                                                                                                                                                                                                                                               |
| `agent-sol`                    | `Reference agent wallet holds <n> SOL; fees need 0.1`                                                                                                                                   | 10 min            | Send devnet SOL to the agent wallet. It pays its own fees and the rent of its YES and NO accounts (claims return that rent)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `agent-musdc`                  | `Reference agent wallet holds <n> mUSDC, under 200`                                                                                                                                     | 10 min            | Live runs only: a dry run logs it at most hourly and plans against its spend cap (J). The agent claims the faucet (1,000 mUSDC) every hour and claims its winnings; under 1 mUSDC it stops swapping. Nothing to do unless it lasts                                                                                                                                                                                                                                                                                                                             |
| `decode:<gameId>`              | `<gameId>: its GameMarket account does not decode`                                                                                                                                      | 3 h               | The keeper skips that market: no halt, draft or settlement for it. Watch the game by hand; the deployed program and `packages/sdk/idl/horagon.json` likely differ                                                                                                                                                                                                                                                                                                                                                                                              |
| `feed-skipped:<ET date>`       | `<n> ESPN events on <ET date> could not be read; check the feed`                                                                                                                        | 10 min            | Those games are not observed: no halts or drafts from the feed. Watch them on a live source and halt by hand if needed (F); check the log for the parse error                                                                                                                                                                                                                                                                                                                                                                                                  |
| `index-stuck:<market>`         | `Indexing of <gameId> (market <market>) is stuck`                                                                                                                                       | 3 h               | One transaction (or the market's signature list) stays unreadable, so trades and prices of that market lag on the site. Check the RPC; indexing resumes once it can read it                                                                                                                                                                                                                                                                                                                                                                                    |
| `index-skip:<market>`          | `Indexing of <gameId> (market <market>) skipped a row`                                                                                                                                  | 3 h               | One trade, claim or redeem is missing from the database for good (that wallet's P&L is off): its token flows could not be read, or did not add up (a claim must pay what its winning side burned, a redeem must burn equal YES and NO for the same collateral). Note it; nothing to do on chain                                                                                                                                                                                                                                                                |
| `tick-failing`                 | `The keeper's tick step failed <n> rounds in a row`                                                                                                                                     | 3 h               | 12 failed rounds (about a minute): no halts, drafts or settlement while it lasts. Read the error in the log (database or RPC); halt by hand anything that needs it (F)                                                                                                                                                                                                                                                                                                                                                                                         |
| `index-failing`                | `The keeper's index step failed <n> rounds in a row`                                                                                                                                    | 3 h               | Trades and prices stop updating; markets are not affected. Read the error in the log                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `index-rate-limited`           | `The RPC has rate-limited the keeper's index reads for <n> min`                                                                                                                         | 3 h               | Every index and ATA watch read has been paused after a rate limit (30 s doubling to 10 min) for over 15 min: trades, claims, positions and prices stop updating; halts, proposals and finalizes are not affected. Wait: the pause ends by itself once the RPC answers. If it lasts into a game night, give the index reads their own RPC (L)                                                                                                                                                                                                                   |
| `rpc-backup-down`              | `Backup RPC 1 failed the cluster check 3 times`                                                                                                                                         | once a start      | The keeper runs on the primary RPC only. Fix `HORAGON_RPC_BACKUP_URL` in `.env.keeper` and restart when convenient (G), not near a close                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `rpc-index-down`               | `Index RPC <host> failed the cluster check 3 times`                                                                                                                                     | once a start      | Index reads use the main RPC, as without `HORAGON_INDEX_RPC_URL`. Fix it in `.env.keeper` and restart when convenient (G), not near a close                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `archive`                      | `The raw ESPN archive could not be written`, or `ESPN archive retention failed`                                                                                                         | 3 h               | Markets are not affected. Check the VPS's free disk space and `apps/keeper/data/archive`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `heartbeat`                    | `Keeper heartbeat is <n> s old during a game night`                                                                                                                                     | 15 min (watchdog) | From the watchdog: no keeper heartbeat for 120 s between 90 min before a tip-off and 4 h after. Read the log, then restart (G)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `watchdog`                     | `Watchdog cannot read the keeper heartbeat`                                                                                                                                             | every run (2 min) | The database does not answer the watchdog, so the keeper likely fails too (`tick-failing`). Check Supabase and `DATABASE_URL`                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## After the last game

- `horagon-ops status`: every market of the night is `recycled`, or `proposed`/`finalized`
  waiting for its window and the keeper's next round.
- Halted games that are postponed wait for D. Nothing else stays open.

## Replay (local runs only)

There is no rehearsal before night 1: night 1 itself is the reference agent's dry run (J), and
the production keeper runs `KEEPER_FEED=espn` only.

A replay never runs on the production keeper. Replay games are league NBA, like real ones: on
devnet each replay market is a counted NBA market under `docs/metrics.md`, the public board shows
it as one of that night's games, and the reference agent trades it (`AGENT_PRACTICE` does not
change that: it is about league PRACTICE, which nothing creates yet). A replay is for a local
Surfpool run, with a local database.

`KEEPER_FEED=replay REPLAY_TAG=<tag> REPLAY_TIPOFF=<ISO time>` plays the fixtures of
`tests/fixtures/replay/` as games whose earliest tip-off is at `REPLAY_TIPOFF` (for example
`2026-11-22T23:00:00Z`). The tag is 1 to 6 letters or digits, starting with a letter; game ids
are `nba-<espnId><tag>` and the feed's source URL is `https://horagon.invalid/replay/...`. Use a
new tag for every run, so its markets never collide with an earlier one. `REPLAY_SPEED` (1 to
60) plays game time that many times faster.
