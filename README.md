# Horagon

Game-day prediction markets that humans play and agents can trade.

Horagon runs one "will the home team win?" market per NBA game on
[pm-AMM](https://github.com/sparkfun-labs/pm-amm) (Solana). Liquidity decays with the game
clock, and every position you hold tonight sits on one screen.

> **Play-money on devnet. No real value. No prizes.**

## Status

Tier 0 (foundation and spikes). Spike results live in [`docs/spikes.md`](docs/spikes.md).

## Repository

| Path                         | What it is                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `packages/sdk`               | `@horagon/sdk`: pm-AMM math and quotes, market decoding, errors, model, evidence hashing        |
| `packages/sdk/vendor/pm-amm` | Vendored pm-AMM TypeScript SDK, pinned to a commit ([VENDOR.md](packages/sdk/vendor/VENDOR.md)) |
| `packages/api`               | API v1 internals; today the sponsor transaction validator                                       |
| `spikes`                     | Tier 0 feasibility spikes (throwaway code, kept for the record)                                 |
| `docs`                       | Developer setup, spike report, runbooks                                                         |

## Develop

Requires Node 22+ and pnpm 10 (`corepack enable`). Solana and Anchor tooling: see
[`docs/dev-setup.md`](docs/dev-setup.md).

```bash
pnpm install
pnpm check   # lint, typecheck, test, build
```

## License

MIT. The vendored pm-AMM SDK keeps its own MIT license
(`packages/sdk/vendor/pm-amm/LICENSE`).
