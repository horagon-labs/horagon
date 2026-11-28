# Developer setup

Horagon builds on Windows, macOS or Linux. TypeScript work needs only Node and pnpm. The
Solana toolchain (Rust, Agave CLI, Anchor, Surfpool) is needed for the on-chain program and the
local sandbox; on Windows it runs inside WSL2.

## TypeScript (every platform)

- Node 22 or newer (`.nvmrc` says 22). CI runs 22, the version the keeper runs on the VPS;
  local development may use a newer one.
- pnpm 10 through Corepack: `corepack enable`. The exact version comes from `packageManager`
  in `package.json`.

```bash
pnpm install
pnpm check   # biome, tsc, vitest, tsup
```

The other packages import the SDK from its `dist/`, which `pnpm check` builds through
Turborepo. Before running one package on its own (`pnpm --filter @horagon/api test`, `... dev`),
build what it depends on: `pnpm turbo run build --filter @horagon/api^...` (or `pnpm build`
once).

`pnpm install` prints "Ignored build scripts: bigint-buffer, bufferutil, utf-8-validate". That
is expected: those native addons of `@solana/web3.js` have pure-JS fallbacks, and tests print
"bigint: Failed to load bindings, pure JS will be used". CI prints the same line on stderr and
does not fail on it.

## Solana toolchain

On Windows, first install WSL2 with Ubuntu from an administrator PowerShell, then reboot and
create the Linux user when asked:

```powershell
wsl --install -d Ubuntu-24.04
```

Everything below runs inside Ubuntu (WSL2, or native Linux/macOS with the equivalent packages).

```bash
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev libudev-dev llvm libclang-dev \
  protobuf-compiler curl git

# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"

# Agave (Solana CLI)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.profile
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Anchor 1.2.2 through avm
cargo install --git https://github.com/solana-foundation/anchor avm --force
avm install 1.2.2
avm use 1.2.2

# Surfpool
curl -sL https://run.surfpool.run/ | bash
```

Check the versions; `docs/spikes.md` records the ones the spikes ran with.

```bash
rustc --version && solana --version && anchor --version && surfpool --version
```

### Working from WSL on a Windows checkout

The repository stays on the Windows drive (for example `E:\...\horagon` is
`/mnt/e/.../horagon` in WSL). `.gitattributes` forces LF line endings so the same files build
on both sides. Run `anchor` and `solana` from WSL; run `pnpm` from Windows or WSL, not both
on the same `node_modules` at once.

### Working on a remote Linux host

The Solana toolchain can also live on a Linux server you reach over SSH; Tier 0 used an
Ubuntu 24.04 VPS this way instead of WSL. Give the server an alias in `~/.ssh/config`,
install the packages and tools above there, and keep the checkout on your own machine:

```bash
# Copy the committed tree to the server; it needs no Git credentials.
git archive HEAD | ssh <alias> 'mkdir -p ~/horagon && tar -x -C ~/horagon'

# Reach a Surfpool running on the server at the usual local address.
# 8900 is the WebSocket port web3.js uses to confirm transactions.
ssh -N -L 8899:127.0.0.1:8899 -L 8900:127.0.0.1:8900 <alias>
```

Build outputs that must come back to the checkout, such as a program keypair or `.so`,
return with `scp`.

## Local chain: Surfpool

Surfpool forks devnet lazily: pm-AMM, Metaplex and any account you touch load from devnet on
first use. Start it from an empty directory, not from an Anchor workspace (inside one it
generates and runs deployment runbooks):

```bash
mkdir -p ~/surfnet && cd ~/surfnet
surfpool start --rpc-url https://api.devnet.solana.com --no-tui
```

It serves JSON-RPC on `http://127.0.0.1:8899`. WSL2 forwards localhost, so Node on Windows
reaches it at the same address. The clock moves forward with the `surfnet_timeTravel`
cheatcode (`absoluteTimestamp` in milliseconds); `spikes/src/lib/surfnet.ts` wraps it and
checks the Clock sysvar afterwards.

The program's integration suite needs a chain without the devnet deployment of the program:
`scripts/program-it.sh` builds one ([testing.md](testing.md)).

## Keys

Spike and local keypairs live in `.keys/<name>.json` (Solana CLI format, git-ignored, created
on first use). They are devnet/localnet only. Never put a mainnet key there.
