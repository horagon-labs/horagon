# Testing

## Every package

`pnpm check` runs Biome, the TypeScript type check, every package's tests with their coverage
floors, and the build; `.github/workflows/ci.yml` runs the same on Node 22. The program suite
below is skipped there: it needs a chain, and runs only when `HORAGON_IT_RPC` names one.

## The program suite (`tests/integration`)

17 cases run the `horagon` program against the real pm-AMM program:

- the lifecycle: create and seed from the treasury, trade, halt, propose, challenge, finalize,
  recycle and claim, with the compute units of create, halt, recycle and claim checked against
  their limits;
- a wrong signer on every restricted instruction;
- quotes against the chain at 30 s and 10 s before `end_ts`;
- three cases that record what the program does not stop, as it behaves today:
  - a wallet that deposits liquidity into a Horagon market keeps it trading after `halt`, which
    withdraws only Horagon's own liquidity;
  - the admin shortening the dispute window while a result is pending ends that window at once:
    `finalize` runs early and a guardian can no longer challenge;
  - after a challenge the program takes a new proposal from the attestor's key, not only a
    guardian's (the keeper is what leaves that proposal to a guardian).

### Run it locally (Linux or macOS)

It needs Agave 4.1.2 (`solana-test-validator`), Anchor 1.2.2 and Surfpool 1.7.0
([dev-setup.md](dev-setup.md)), Node 22 and pnpm. On Windows, use WSL2 or a Linux host.

```bash
pnpm install
anchor build
bash scripts/program-it.sh
```

[`scripts/program-it.sh`](../scripts/program-it.sh) starts two local processes and stops them
when it ends:

1. `solana-test-validator`, which clones pm-AMM and Metaplex from devnet (reads only) and loads
   `target/deploy/horagon.so` at the program id, with a throwaway upgrade authority made for the
   run (the suite's admin, `HORAGON_IT_ADMIN`);
2. Surfpool, forking that validator, because the suite moves the clock with
   `surfnet_timeTravel` (one of its markets lives two days).

It then runs the suite and fails when any case fails or is skipped. Logs and the JSON report
stay in `target/program-it`.

Surfpool does not fork devnet directly here: on devnet the program id holds the deployed program
and its `Config`, so `initialize_config` could never run, and every account the suite touches
would be another request to the public devnet RPC.

Against a chain you started yourself (fresh, with the program at its id, no `Config`, and your
key as its upgrade authority):

```bash
HORAGON_IT_RPC=http://127.0.0.1:8899 HORAGON_IT_ADMIN=path/to/authority.json \
  pnpm --filter @horagon/integration test
```

### In CI

`.github/workflows/program.yml`, job `integration`, runs after `build`: it restores the
toolchain cache, runs `anchor build`, installs Surfpool 1.7.0 pinned by checksum and runs
`scripts/program-it.sh`. On a failure it keeps the validator and Surfpool logs as the
`program-it-logs` artifact. It needs no secret. It runs when the program, the SDK sources, the
suite, the script or the workflow change, and on demand (`workflow_dispatch`).
