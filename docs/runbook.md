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

| What                                       | Where                                                                                                                                                                                                                                           |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keeper code                                | The VPS, `~/horagon` (a tarball of the deployed commit; `~/horagon/REVISION` names it)                                                                                                                                                          |
| Keeper variables                           | The VPS, `~/horagon/.env.keeper` (`chmod 600`), read by both units                                                                                                                                                                              |
| Attestor key (the keeper's signer)         | The VPS, `~/horagon/.keys/attestor.json` (`chmod 600`), and nowhere else                                                                                                                                                                        |
| Elo ratings and model sigma                | The VPS, `~/horagon/apps/keeper/data/elo.json` (copied by hand, `docs/deploy.md`); the keeper does not start without it. Sigma, the in-game model's spread, is the measured standard deviation of the home margin over the 2025-26 season: 16.5 |
| Raw ESPN archive                           | The VPS, `~/horagon/apps/keeper/data/archive/<ET date>.ndjson`; gzipped after 2 days, deleted after 30                                                                                                                                          |
| Units                                      | The VPS, `~/.config/systemd/user/`: `horagon-keeper.service`, `horagon-watchdog.service`, `horagon-watchdog.timer` (copied from `ops/systemd` by every deploy)                                                                                  |
| Admin and guardian keys                    | Your machine, `.keys/deployer.json` and `.keys/guardian.json`                                                                                                                                                                                   |
| Web app and API v1                         | Vercel; the sponsor key is its `SPONSOR_SECRET_KEY`                                                                                                                                                                                             |
| Database                                   | Supabase Postgres (`DATABASE_URL`)                                                                                                                                                                                                              |
| `keeper_heartbeats` row `keeper`           | Written by the keeper after every round (5 s): `round`, `actions`, `feed` and the failure streaks `failing.tick` and `failing.index`. `status` prints it; `/api/v1/health` reads its age                                                        |
| `keeper_heartbeats` row `watchdog`         | The time of the watchdog's last `heartbeat` page (`pagedAt`), so a new watchdog run knows when it paged                                                                                                                                         |
| `keeper_heartbeats` row `propose:<gameId>` | The `propose` attempts of one game: the evidence hash, the challenge round, and how each send ended. `status` prints the newest one                                                                                                             |

## The day before (by 05:00 UTC)

1. `horagon-ops status --date <ET date>`: the games whose tip-off falls in the 48 h from 00:00 UTC
   of that date (without `--date`: from 12 h ago), by tip-off, with `featured` on the featured
   ones and `no market` until S − 60 min. The first line is the keeper heartbeat.
2. Featured games (at most 4 a date, 1,000 mUSDC seed instead of 300): the hourly schedule pass
   picks them once per date. To change them: `horagon-ops featured <ET date> <gameId>...` (1 to
   4 ids; it replaces that date's choice, and the schedule pass keeps it). The seed is taken
   when the market is created, so change them before S − 60 min.
3. Treasury: every hour the keeper claims 1,000 mUSDC from the faucet for the attestor wallet
   and moves the attestor's mUSDC into the treasury, up to the seeds of the next 36 h + 20 %.
   A 12-game night needs 7,680 mUSDC, so a fresh treasury needs about 8 hourly passes. If
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

Markets trade through the game until the on-chain `end_ts = S + 2h10m`; nothing halts them at
tip-off. Over the 220 games measured, the close came before the final buzzer in 219. The
keeper halts a market that is still open (a halt withdraws all of Horagon's liquidity and cannot
be undone) on the first of:

- a Final read before the close (`final-before-end`);
- the feed showing the game postponed or canceled (`postponed`);
- the game not started 24 h after S (`not-started`);
- no feed read for 10 min while the feed last showed Q4 or overtime (`feed-silent`).

After 2 min without a feed in Q4 or overtime it only alerts (`feed-silent-q4:`). From 30 min
before the close (S + 1h40m) it also alerts on 2 min without a feed whatever quarter the feed
last showed, and at once for a game it has not read since it started (`feed-silent:`): an outage
that begins in Q3 would otherwise hide Q4. That alert never halts.

Once ESPN has shown Final with the same score for 60 s, the keeper drafts the result and sends
`draft:`. You confirm it against a public box score and propose it (procedure A). The keeper
finalizes once the dispute window (15 min with the default `--window 900`) has passed, then
recycles. `status` then shows `market:finalized`, then `market:recycled`.

## Procedures

### A. Propose a Final

1. On `draft:<gameId>:<count>`, open the game's box score on nba.com or basketball-reference.com
   (espn.com is accepted with a warning: it is the feed itself) and check the final score
   against the alert. `draft:` and `status` show the score away-home, like `AWAY@HOME`, while
   `periods:` and `tie:` print it home-away after `AWAY@HOME`. `--score` takes home-away, so
   copy the command line the `draft:` alert prints.
2. Run it:
   `horagon-ops propose <gameId> --box-score <url> --score <home>-<away>`.
   - It refuses before the close: `proposing opens at end_ts <time>`. Run it again after that
     time (this happens only for a game that ended before S + 2h10m; its market is halted).
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
   with your own `--periods`.
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
and the game may end before the close: `horagon-ops halt <gameId>`. It withdraws all of
Horagon's liquidity; it cannot be undone, and the market stays halted until its result is
proposed. A market that is not open prints `<gameId> is already <status>; nothing to halt`.

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
- Avoid the last 30 min before any game's close: a stop holds back halts until the new process
  runs, and the new process alerts `feed-silent:` until its first feed read (below).
- The next start checks every RPC's cluster, then re-plans every action from chain state: work
  that landed is seen on chain and not repeated. (`isDone` is asked only between the retries of
  one send, not across a restart.) A transaction in flight when the keeper stopped may land
  after the new process read the chain, which then sends the same action again: the chain
  refuses one of the two (create, halt, finalize, recycle), and when it refuses the new one it
  arrives as `fail:<action>:<gameId>`. That is expected once `status` shows the effect. A
  treasury top-up can land twice (accepted: play money, inside the project's own accounts). The
  keeper keeps no attempt records of its own sends; only `horagon-ops propose` does.
- The first round after a start also runs the hourly steps (schedule, treasury, archive
  retention), and the alerter has forgotten what it sent, so open alerts come again.
- In the last 30 min before a close, a game the keeper has not read since the start (ESPN not
  answering) alerts `feed-silent:` at once, until a feed read includes it. The feed is read
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
2. Before S, restart the keeper (G), unless another game is in its last 30 min before a close.
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
treasury holding the seed: 1,000 mUSDC for a featured game, 300 for the others (a featured game
takes 300 when the treasury holds 300 to 1,000, with a `treasury-low` alert).

### I. Turn a feature off

Each Tier 2 feature sits behind a flag, and every flag starts off: `FLAG_ME`, `FLAG_METRICS`,
`FLAG_METRICS_COHORT`, `FLAG_SHARE`, `FLAG_RANK`, `FLAG_CREWS`, `FLAG_TELEGRAM`, `FLAG_CLUTCH`,
`FLAG_PRACTICE` and `FLAG_VERIFY`. While a flag is off, the API routes behind it answer 404
(`application/problem+json`), POST routes too, and the pages built on them hide the feature.
The API reads the flags on every request, so a change applies at once, with no deploy and no
restart.

When a feature misbehaves during a night, turn its flag off first and look into it after:

```bash
horagon-ops flag off FLAG_SHARE
```

The command prints every flag with its state and logs the change in `ops_events` (actor ops,
action flag). Turn the flag back on once the fix is deployed:

```bash
horagon-ops flag on FLAG_SHARE
```

`GET /api/v1/flags`, `POST /api/v1/tx/trade` and the Tier 1 game routes have no flag.

## Alerts

One row per alert key. "Repeats" is the shortest gap between two messages with the same key
from one process: 10 min by default, and 3 h for the keys that wait on a person. A restart
forgets what was sent, each `horagon-ops` run is a process of its own, and a message that
Telegram did not take is tried again after 60 s. `<count>` is the market's on-chain challenge
count (0 before any challenge), so a new challenge round is never held back. `<label>` names the
transaction: `create <gameId>`, `halt <gameId> (<rule>)`, `finalize <gameId>`, `recycle
<gameId>`, `treasury top-up`, and from `horagon-ops`: `propose <gameId>`, `challenge <gameId>`,
`halt <gameId> (guardian)`, `initialize_config`, `pause creation`, `resume creation`,
`fund authority`.

| Key                            | Telegram text begins with                                                                                                                                         | Repeats           | What to do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draft:<gameId>:<count>`       | `AWAY@HOME Final <away>-<home> (ESPN). Check the box score`, or `... was not played within 7 days. Resolve NO`                                                    | 10 min            | Propose: A for a Final, D for NO                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `unconfirmed:<gameId>:<count>` | `AWAY@HOME: final draft waiting 30 min for the guardian's box-score check` (or `postponed draft`)                                                                 | once a draft      | Propose now (A or D)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `challenge:<gameId>:<count>`   | `Challenged: AWAY@HOME.`                                                                                                                                          | 10 min            | C                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `evidence-mismatch:<gameId>`   | `Evidence mismatch: AWAY@HOME has sha256 ... on chain, but the API serves ...`                                                                                    | 3 h               | E, before the dispute window closes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `periods:<gameId>`             | `AWAY@HOME: ESPN periods do not add up to <home>-<away>; resolve by hand`                                                                                         | 3 h               | No draft. Propose with `--score` and `--periods` from the box score (A)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tie:<gameId>`                 | `AWAY@HOME: ESPN Final is tied <home>-<away>; resolve by hand`                                                                                                    | 3 h               | No draft (an NBA game cannot end tied, so the feed is wrong). Propose with `--score` and `--periods` from the box score (A)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `no-feed:<gameId>`             | `AWAY@HOME: no feed 7 days after tip-off; resolve by hand`                                                                                                        | 10 min            | D                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `stuck:<gameId>`               | `AWAY@HOME: market closed over 6 h ago with no result draft; resolve by hand`                                                                                     | 3 h               | Check the box score; propose with `--periods` (A), or `--postponed --notice` (D)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `feed-silent-q4:<gameId>`      | `AWAY@HOME: no feed for <n> min in Q4/OT, market still open; the keeper halts at 10 min`                                                                          | 10 min            | Watch the game on a live source. If it may end before the close and the feed is still down: `horagon-ops halt <gameId>` (F)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `feed-silent:<gameId>`         | `AWAY@HOME: no feed for <n> min, last seen ...`, or `... no feed read since the keeper started`                                                                   | 10 min            | Same as `feed-silent-q4:`. This one never halts by itself                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `halt:<gameId>`                | `Halted AWAY@HOME: <rule>`                                                                                                                                        | 10 min            | `final-before-end`: wait for `draft:`. `feed-silent`: check the box score; if the game is still on, nothing to do (the market stays halted until its result). `postponed`, `not-started`: D                                                                                                                                                                                                                                                                                                                                                                    |
| `no-p0:<gameId>`               | `AWAY@HOME: no p0, market not created`                                                                                                                            | 10 min            | The game's row has no pre-game probability, which the hourly schedule step writes for every game it reads. Look for a failing `schedule` step in the log. A market can still open while the game has not started, until S + 30 min                                                                                                                                                                                                                                                                                                                             |
| `treasury-low`                 | `Treasury <n> mUSDC, next 36 h needs <n>`, or `Treasury <n> mUSDC: <gameId> seeded at 300 instead of 1,000`                                                       | 10 min            | Add mUSDC to the attestor wallet ("The day before", step 3). Featured games get the 300 seed meanwhile                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `treasury-empty:<gameId>`      | `Treasury <n> mUSDC: cannot seed <gameId>`                                                                                                                        | 10 min            | No market for that game until the treasury holds its seed; the keeper retries every round while the game has not started, until S + 30 min. The hourly top-up may come too late: fill the treasury now (H)                                                                                                                                                                                                                                                                                                                                                     |
| `treasury-unread`              | `Treasury balance could not be read <n> times in a row`                                                                                                           | 3 h               | No market is created until the RPC answers. Check `HORAGON_RPC_URL` and the RPC provider                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `sol-authority`                | `Authority holds <n> SOL, under 2 nights of markets`                                                                                                              | 10 min            | `horagon-ops fund-authority <sol>` (G: check before repeating it)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `sol-keeper`                   | `Keeper wallet holds <n> SOL; fees need 0.2`                                                                                                                      | 10 min            | Send devnet SOL to the attestor wallet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ata-close:<wallet>`           | `Wallet <wallet> closed sponsor-paid ATA <ata>, rent to <address>`                                                                                                | 10 min            | The API opens no more token accounts for that wallet. A close that a traced claim_winnings made (YES or NO of its own user and market, rent to the player) never raises it and is recorded as "claim". The trace reads the account's signatures newest first back to its creation, over as many passes as heavy noise needs, and records "unknown" (and raises this alert) only when it reaches the creation without finding a close. Many in a night: lower `SPONSOR_ATAS_PER_IP_DAY` on Vercel, then redeploy                                                |
| `ata-trace:<ata>`              | `The close of sponsor-paid ATA <ata> (wallet <wallet>) is still being traced after <n> passes: heavy transaction noise on the account. The wallet is not flagged` | 3 h               | Noise on the account hides its close and the keeper keeps tracing it, 200 transactions per pass; nothing is flagged meanwhile. Check by hand: open the ATA address in an explorer (or `solana transaction-history <ata>`) and look for a CloseAccount, or a `claim_winnings` that closes it. If the rent went to the sponsor or to a claim, nothing to do (the trace ends by itself once it reaches the close). If it went to another address, the wallet is not blocked until the trace says so: lower `SPONSOR_ATAS_PER_IP_DAY` on Vercel if it is an attack |
| `external-lp:<market>`         | `External liquidity added to <gameId>; the pool is no longer Horagon's alone`                                                                                     | 10 min            | Nothing to do: the game page shows it, and a halt withdraws only Horagon's share                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `fail:<action>:<gameId>`       | `<action> <gameId> rejected: ... error <name>`                                                                                                                    | 10 min            | The program refused a keeper action (`create`, `halt`, `finalize`, `recycle`). Read the error name and check `status`; the keeper plans it again every round                                                                                                                                                                                                                                                                                                                                                                                                   |
| `tx:<label>`                   | `Transaction "<label>" failed 4 times (...); 1 attempt left`                                                                                                      | 10 min            | Check the RPC (`HORAGON_RPC_URL`). The keeper plans the action again on the next round                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tx-unresolved:<label>`        | `<label>: unresolved after 90 s, <signature> may still land`                                                                                                      | 10 min            | The transaction may still land: look the signature up before doing anything by hand. The keeper re-plans from chain state; for a `horagon-ops` command, B (propose) or G (`fund-authority`)                                                                                                                                                                                                                                                                                                                                                                    |
| `decode:<gameId>`              | `<gameId>: its GameMarket account does not decode`                                                                                                                | 3 h               | The keeper skips that market: no halt, draft or settlement for it. Watch the game by hand; the deployed program and `packages/sdk/idl/horagon.json` likely differ                                                                                                                                                                                                                                                                                                                                                                                              |
| `feed-skipped:<ET date>`       | `<n> ESPN events on <ET date> could not be read; check the feed`                                                                                                  | 10 min            | Those games are not observed: no halts or drafts from the feed. Watch them on a live source and halt by hand if needed (F); check the log for the parse error                                                                                                                                                                                                                                                                                                                                                                                                  |
| `index-stuck:<market>`         | `Indexing of <gameId> (market <market>) is stuck`                                                                                                                 | 3 h               | One transaction stays unreadable, so trades and prices of that market lag on the site. Check the RPC; indexing resumes once it can read it                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `index-skip:<market>`          | `Indexing of <gameId> (market <market>) skipped a row`                                                                                                            | 3 h               | One trade, claim or redeem is missing from the database for good (that wallet's P&L is off): its token flows could not be read, or did not add up (a claim must pay what its winning side burned, a redeem must burn equal YES and NO for the same collateral). Note it; nothing to do on chain                                                                                                                                                                                                                                                                |
| `tick-failing`                 | `The keeper's tick step failed <n> rounds in a row`                                                                                                               | 3 h               | 12 failed rounds (about a minute): no halts, drafts or settlement while it lasts. Read the error in the log (database or RPC); halt by hand anything that needs it (F)                                                                                                                                                                                                                                                                                                                                                                                         |
| `index-failing`                | `The keeper's index step failed <n> rounds in a row`                                                                                                              | 3 h               | Trades and prices stop updating; markets are not affected. Read the error in the log                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `rpc-backup-down`              | `Backup RPC 1 failed the cluster check 3 times`                                                                                                                   | once a start      | The keeper runs on the primary RPC only. Fix `HORAGON_RPC_BACKUP_URL` in `.env.keeper` and restart when convenient (G), not near a close                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `archive`                      | `The raw ESPN archive could not be written`, or `ESPN archive retention failed`                                                                                   | 3 h               | Markets are not affected. Check the VPS's free disk space and `apps/keeper/data/archive`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `heartbeat`                    | `Keeper heartbeat is <n> s old during a game night`                                                                                                               | 15 min (watchdog) | From the watchdog: no keeper heartbeat for 120 s between 90 min before a tip-off and 4 h after. Read the log, then restart (G)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `watchdog`                     | `Watchdog cannot read the keeper heartbeat`                                                                                                                       | every run (2 min) | The database does not answer the watchdog, so the keeper likely fails too (`tick-failing`). Check Supabase and `DATABASE_URL`                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## After the last game

- `horagon-ops status`: every market of the night is `recycled`, or `proposed`/`finalized`
  waiting for its window and the keeper's next round.
- Halted games that are postponed wait for D. Nothing else stays open.

## Rehearsal (replay)

`KEEPER_FEED=replay REPLAY_TAG=<tag> REPLAY_TIPOFF=<ISO time>` plays the fixtures of
`tests/fixtures/replay/` as games whose earliest tip-off is at `REPLAY_TIPOFF` (for example
`2026-11-22T23:00:00Z`). The tag is 1 to 6 letters or digits, starting with a letter; game ids
are `nba-<espnId><tag>` and the feed's source URL is `https://horagon.invalid/replay/...`. Use a
new tag for every run, so its markets never collide with an earlier one. Keep `REPLAY_SPEED=1`
on devnet; a faster replay (up to 60) is for a local Surfpool run.
