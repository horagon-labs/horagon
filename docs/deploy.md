# Deploy (devnet)

Play-money on devnet. No real value. No prizes.

Four pieces run in four places:

| Piece             | Where                                       | How it ships                                                                                                                                                                 |
| ----------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program `horagon` | Solana devnet                               | `solana program deploy` where the Solana CLI runs, with the upgrade key `.keys/deployer.json`                                                                                |
| Web + API v1      | Vercel (project `horagon`, root `apps/web`) | `vercel deploy --prod` from the repo root of a clean tree (`.vercelignore` keeps keys and env files out). The Git integration is off: pushing `main` does not deploy the web |
| Keeper + watchdog | The VPS, user `horagon`, systemd user units | `bash ops/deploy-keeper.sh`, with `HORAGON_VPS` set to your SSH host alias                                                                                                   |
| Database          | Supabase Postgres                           | `pnpm --filter @horagon/db db:migrate`                                                                                                                                       |

## Keys

All keys are devnet-only Solana CLI keypair files in `.keys/` (git-ignored). Create the
missing ones with `solana-keygen new --no-bip39-passphrase -o .keys/<name>.json`. The
originals stay on your machine: a remote build host (`docs/dev-setup.md`, "Working on a remote
Linux host") gets a copy of the deployer only for the command that signs with it, removed when
that command ends. The attestor and the agent key are the exceptions: they live on the VPS, and
the agent key is generated there (below).

| File            | Role                                                                                                                                   | Lives on                                           | Needs                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------- |
| `deployer.json` | Admin: program upgrade authority, `initialize_config`, `update_config`, `withdraw_treasury`; `horagon-ops` admin commands sign with it | your machine                                       | ~3 SOL for the first deploy, then little  |
| `attestor.json` | Keeper signer: `create_game_market`, `halt`, `propose_result`; also the keeper wallet that claims the faucet and fills the treasury    | the VPS (`~/horagon/.keys/`) and nowhere else      | ≥ 0.2 SOL (below it, `sol-keeper` alerts) |
| `guardian.json` | Guardian 1: `challenge`, `propose_result`, `halt`; `horagon-ops` guardian commands sign with it                                        | your machine                                       | ~0.05 SOL                                 |
| `sponsor.json`  | Pays fees and token-account rent of player transactions                                                                                | Vercel env `SPONSOR_SECRET_KEY` (local: see below) | 1–2 SOL, topped up by hand                |
| `agent.json`    | The reference agent (procedure J of `docs/runbook.md`): signs and pays its own swaps and claims; never the sponsor                     | the VPS (`~/horagon/.keys/`) and nowhere else      | ≥ 0.1 SOL (below it, `agent-sol` alerts)  |

Local runs only: instead of `SPONSOR_SECRET_KEY`, set `SPONSOR_KEYPAIR` to the **absolute**
path of the keypair file (for example `$PWD/.keys/sponsor.json` from the repo root). The web
server runs in `apps/web`, so a relative path is refused. When `SPONSOR_SECRET_KEY` is set it
wins and the file is not read. Vercel uses `SPONSOR_SECRET_KEY` only.

The Authority PDA pays the rent of every market (0.03538 SOL each; the keeper budgets 0.036):
fund it with `horagon-ops fund-authority <sol>` (signs with `deployer.json`, at most 10 SOL a
call). `sol-authority` alerts below 2 × max(n, 4) × 0.036 SOL, where n is the number of next
night's games still without a market: keep about 0.9 SOL there (two nights of 12 games).

`horagon-ops` below is `pnpm --filter @horagon/keeper ops`, run from the repo root with the
variables it needs exported (`docs/runbook.md`, "Before you start").

## One-time setup

1. **Supabase:** create a project; copy the transaction-pooler connection string (port
   6543) into `DATABASE_URL`; run `pnpm --filter @horagon/db db:migrate` from your machine.
2. **Program:** where the Solana toolchain runs (`docs/dev-setup.md`), run `anchor build`,
   `anchor keys sync` and `anchor build` as three separate commands, copy the program id into
   both sections of `Anchor.toml` and `declare_id!` in your checkout, then
   `solana program deploy target/deploy/horagon.so --program-id target/deploy/horagon-keypair.json --keypair .keys/deployer.json --url devnet`.
   Keep a copy of `target/deploy/horagon-keypair.json` as `.keys/horagon-program.json`. Copy
   `target/idl/horagon.json` to `packages/sdk/idl/horagon.json` and commit (the `program`
   workflow fails when they differ).
3. **Config:** `ATTESTOR_PUBKEY=<attestor pubkey> horagon-ops init-config --guardian <guardian pubkey> --window 900`
   (signs with `deployer.json`; `--window` is the dispute window in seconds, 60 to 604800), then
   mark the four keys as team wallets, left out of every metric:
   `horagon-ops team <deployer pubkey> <attestor pubkey> <guardian pubkey> <sponsor pubkey>`.
4. **Vercel:** `vercel link`, then `vercel deploy --prod` at the repo root (the Git integration is
   off, so a push never deploys); framework Next.js, root
   `apps/web`, install command `pnpm install --frozen-lockfile`, build command
   `pnpm --filter @horagon/sdk build && pnpm --filter @horagon/web build`. Set the
   "Shared" and "Web and API" variables of `.env.example`.
5. **VPS:** as `horagon`, check Node: `~/.local/bin/node --version` (22.x) and
   `corepack --version`. Ask root once for `loginctl enable-linger horagon`. Copy
   `.keys/attestor.json` to `~/horagon/.keys/` (`chmod 600`) and write
   `~/horagon/.env.keeper` from the "Shared" and "Keeper" parts of `.env.example`
   (`chmod 600`). Leave an optional variable commented out rather than empty: the keeper
   refuses an empty `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `HORAGON_RPC_BACKUP_URL`,
   `REPLAY_TAG`, `REPLAY_TIPOFF` or `SEED_*_USDC`. Auto-propose reads three more (below).
6. **Elo ratings:** `pnpm --filter @horagon/keeper elo:build` on your machine, then copy the
   file; the keeper does not start without it:

   ```bash
   ssh "$HORAGON_VPS" 'mkdir -p ~/horagon/apps/keeper/data'
   scp apps/keeper/data/elo.json "$HORAGON_VPS":horagon/apps/keeper/data/elo.json
   ```

## Auto-propose (the keeper's variables)

The keeper's attestor proposes each checked Final itself (`docs/runbook.md`, procedure K). It
reads these from `~/horagon/.env.keeper`; check them by name only, never by printing the file:

| Variable              | Default        | What it does                                                                                                                                           |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HORAGON_PUBLIC_URL`  | unset          | The "Shared" variable: the https site of the evidence URI on chain, the same origin `horagon-ops propose` uses. Unset or unusable, auto-propose is off |
| `KEEPER_AUTO_PROPOSE` | `on`           | `on`, `dry` (pages what it would propose, sends and writes nothing) or `off`. A blank line keeps the default                                           |
| `BALLDONTLIE_API_KEY` | unset          | The second source's free-tier key, at least 8 characters, sent in a header only. Unset or blank: no second source, every proposal pages `CHECK`        |
| `TELEGRAM_BOT_TOKEN`  | unset          | With `TELEGRAM_CHAT_ID`, where the pages go. Without both, the keeper logs at start that auto-propose pages reach the journal only                     |
| `KEEPER_TIMINGS`      | (the defaults) | `secondSourceWaitSecs` (600): how long a silent second source is waited for before an unchecked proposal                                               |

Run the first night after the deploy that brings auto-propose with `KEEPER_AUTO_PROPOSE=dry`,
then `on`. Write the balldontlie key into `.env.keeper` on the VPS yourself, never in a chat, the
repository or a command line.

## Reference agent (once, before its first swap)

The agent is optional and off by default (`AGENT_ENABLED` unset). Before it ever trades:

1. **Key:** generate it on the VPS, never on a laptop, so the secret never leaves the VPS. In
   a login shell there (`ssh "$HORAGON_VPS"`), then print only its public key:

   ```bash
   umask 077; solana-keygen new --no-bip39-passphrase --silent -o ~/horagon/.keys/agent.json
   solana-keygen pubkey ~/horagon/.keys/agent.json
   ```

   Send that public key about 0.5 devnet SOL; it claims its mUSDC from the faucet every hour
   once it trades. A dry run claims nothing and plans against a notional balance (its spend cap),
   so an empty mUSDC wallet is fine for its first night.
2. **Disclosure:** add its public key to `docs/metrics-wallets.json` as a `team-burner` entry in a
   public commit (the pre-registered metric reads that file), and mark it a team wallet in the
   database: `horagon-ops team <agent pubkey>`. The agent checks the shipped copy of that file
   when it starts: without the entry it alerts `agent-unlisted`, logs
   `agent wallet is not listed as team-burner in docs/metrics-wallets.json` and exits 0, dry run
   or not.
3. **Variables:** add the "Reference agent" part of `.env.example` to `~/horagon/.env.keeper`, with
   `AGENT_ENABLED=1` and `AGENT_DRY_RUN=1` for the first run. A dry run is also the default: it
   trades only once the file says `AGENT_DRY_RUN=0`.
4. **Start** it by hand after a deploy (`docs/runbook.md`, procedure J), read its dry-run
   decisions, then set `AGENT_DRY_RUN=0` and restart it.

## Every deploy

The order is the keeper first, then the web, both from the same clean commit. The web's
"open until the final buzzer" copy is true only once the keeper halts a market on the first
Final read.

```bash
pnpm check
HORAGON_VPS=<your SSH host alias> bash ops/deploy-keeper.sh
```

The script moves to the repo root, refuses a dirty tree, and ships `HEAD` as a tarball over
ssh to `~/horagon` (it never copies keys or `.env.keeper`). Then, in a login shell on the VPS,
it writes `~/horagon/REVISION`, runs `corepack pnpm install --frozen-lockfile` for the keeper
and its dependencies, builds the SDK, copies the four units of `ops/systemd` to
`~/.config/systemd/user`, enables and starts `horagon-watchdog.timer`, enables
`horagon-keeper` and restarts it, then prints its status. It never enables, starts or restarts
`horagon-agent`. A running agent keeps the previous revision, and the script says so: restart it
by hand (`systemctl --user restart horagon-agent`, procedure J of `docs/runbook.md`) to run the
new one, which also clears the markets its anomaly check stopped. A stopped agent stays stopped.
Before it ships anything, the script runs `horagon-ops deploy-check` on the VPS and refuses
while a game is between tip-off - 60 min and its market's close, listing those games (a restart
there holds back buzzer halts); `--force` deploys anyway (`docs/runbook.md`, procedure G). Logs:
`ssh "$HORAGON_VPS" journalctl --user -u horagon-keeper -f -o cat`.

Then the web, from the same commit. The Git integration is off, so it ships only this way, and
the build gets no commit sha from Vercel: set `HORAGON_VERSION` to the first seven characters of that
commit's sha first, or `/api/v1/health` keeps reporting the previous value (or `dev` when unset), and
a version check passes on a stale value.

```bash
git rev-parse --short=7 HEAD  # set HORAGON_VERSION to this value in the Vercel production env
vercel deploy --prod          # from the repo root, same clean tree
curl -s https://www.horagon.xyz/api/v1/health
```

After a deploy whose keeper adds the `trades.bot_memo` column (migrate first:
`pnpm --filter @horagon/db db:migrate`), run `horagon-ops backfill-bot-memo` until it reports 0
left, so trades indexed before the column existed get their memo flag (`docs/runbook.md`, "Before
you start"). A deploy never restarts the agent.

## Practice (once, then every deploy)

The Practice process (R8, `horagon-practice`) runs beside the keeper on the VPS with the same
`.env.keeper`. No migration: `games.league` exists. Each step waits for the user's word.

1. Deploy the keeper between nights (the league split and the horn halt ship with it):
   `bash ops/deploy-keeper.sh`. It installs `horagon-practice.service` but does not enable it.
2. Add one line to `~/horagon/.env.keeper` on the VPS: `PRACTICE_SOURCE_URL=` and the public
   https URL of the repo's `tests/fixtures/replay` folder on main. The repo's address stays out
   of the code. `HORAGON_PUBLIC_URL` must be set too (auto-propose already needs it).
3. `systemctl --user enable --now horagon-practice`, then
   `journalctl --user -u horagon-practice -n 20 -o cat`: it logs `practice started` with 12
   recordings. From then on every keeper deploy restarts it.
4. Deploy the web (above): the `PRACTICE` plate, `/practice` and the strip on `/` ship with it.
5. `horagon-ops flag on FLAG_PRACTICE`: the next slot (10, 12, 14, 16, 18 or 20:00 UTC) starts
   a run unless an NBA market is near.
6. Watch the first run end to end (`horagon-ops status`, the `practice` heartbeat, the game
   page): create, live, the halt at the buzzer, the propose about 40 min after the start, the
   finalize 15 min later.
7. Top up the attestor's SOL from the devnet faucet if more runs are wanted: each run locks
   about 0.036 SOL of rent, and no run starts under PRACTICE_SOL_FLOOR (1.0 SOL).
