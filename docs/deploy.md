# Deploy (devnet)

Play-money on devnet. No real value. No prizes.

Four pieces run in four places:

| Piece             | Where                                       | How it ships                                                                                                                                                                  |
| ----------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program `horagon` | Solana devnet                               | `solana program deploy` where the Solana CLI runs, with the upgrade key `.keys/deployer.json`                                                                                 |
| Web + API v1      | Vercel (project `horagon`, root `apps/web`) | `vercel deploy --prod` from the repo root of a clean tree (`.vercelignore` keeps keys and env files out), or the Git integration (pushed branches only; production is `main`) |
| Keeper + watchdog | The VPS, user `horagon`, systemd user units | `bash ops/deploy-keeper.sh`, with `HORAGON_VPS` set to your SSH host alias                                                                                                    |
| Database          | Supabase Postgres                           | `pnpm --filter @horagon/db db:migrate`                                                                                                                                        |

## Keys

All keys are devnet-only Solana CLI keypair files in `.keys/` (git-ignored). Create the
missing ones with `solana-keygen new --no-bip39-passphrase -o .keys/<name>.json`. The
originals stay on your machine: a remote build host (`docs/dev-setup.md`, "Working on a remote
Linux host") gets a copy of the deployer only for the command that signs with it, removed when
that command ends. The attestor is the one exception: it lives on the VPS.

| File            | Role                                                                                                                                   | Lives on                                      | Needs                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------- |
| `deployer.json` | Admin: program upgrade authority, `initialize_config`, `update_config`, `withdraw_treasury`; `horagon-ops` admin commands sign with it | your machine                                  | ~3 SOL for the first deploy, then little  |
| `attestor.json` | Keeper signer: `create_game_market`, `halt`, `propose_result`; also the keeper wallet that claims the faucet and fills the treasury    | the VPS (`~/horagon/.keys/`) and nowhere else | ≥ 0.2 SOL (below it, `sol-keeper` alerts) |
| `guardian.json` | Guardian 1: `challenge`, `propose_result`, `halt`; `horagon-ops` guardian commands sign with it                                        | your machine                                  | ~0.05 SOL                                 |
| `sponsor.json`  | Pays fees and token-account rent of player transactions                                                                                | Vercel env `SPONSOR_SECRET_KEY`               | 1–2 SOL, topped up by hand                |

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
4. **Vercel:** import the repo (the Git integration builds only pushed branches, and production is
   `main`), or `vercel link` and `vercel deploy --prod` at the repo root; framework Next.js, root
   `apps/web`, install command `pnpm install --frozen-lockfile`, build command
   `pnpm --filter @horagon/sdk build && pnpm --filter @horagon/web build`. Set the
   "Shared" and "Web and API" variables of `.env.example`.
5. **VPS:** as `horagon`, check Node: `~/.local/bin/node --version` (22.x) and
   `corepack --version`. Ask root once for `loginctl enable-linger horagon`. Copy
   `.keys/attestor.json` to `~/horagon/.keys/` (`chmod 600`) and write
   `~/horagon/.env.keeper` from the "Shared" and "Keeper" parts of `.env.example`
   (`chmod 600`). Leave an optional variable commented out rather than empty: the keeper
   refuses an empty `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `HORAGON_RPC_BACKUP_URL`,
   `REPLAY_TAG`, `REPLAY_TIPOFF` or `SEED_*_USDC`.
6. **Elo ratings:** `pnpm --filter @horagon/keeper elo:build` on your machine, then copy the
   file; the keeper does not start without it:

   ```bash
   ssh "$HORAGON_VPS" 'mkdir -p ~/horagon/apps/keeper/data'
   scp apps/keeper/data/elo.json "$HORAGON_VPS":horagon/apps/keeper/data/elo.json
   ```

## Every deploy

```bash
pnpm check
HORAGON_VPS=<your SSH host alias> bash ops/deploy-keeper.sh
```

The script moves to the repo root, refuses a dirty tree, and ships `HEAD` as a tarball over
ssh to `~/horagon` (it never copies keys or `.env.keeper`). Then, in a login shell on the VPS,
it writes `~/horagon/REVISION`, runs `corepack pnpm install --frozen-lockfile` for the keeper
and its dependencies, builds the SDK, copies the three units of `ops/systemd` to
`~/.config/systemd/user`, enables and starts `horagon-watchdog.timer`, enables
`horagon-keeper` and restarts it, then prints its status. A restart is safe during a night, but
avoid the last 30 min before a close (`docs/runbook.md`, procedure G). Logs:
`ssh "$HORAGON_VPS" journalctl --user -u horagon-keeper -f -o cat`.
