# Vendored code

## `pm-amm/`: the pm-AMM TypeScript SDK

| | |
|---|---|
| Upstream | <https://github.com/sparkfun-labs/pm-amm>, directory `packages/sdk` |
| Commit | `d5b407b6dbb83272e7dcd5b767270d5fd64786f1` |
| Upstream package | `@pm-amm/sdk` 0.2.0 |
| License | MIT, `pm-amm/LICENSE` (copied from the upstream repository) |
| Vendored | 2026-11-18 |
| IDL sha256 | `c1b26cbf6cae4a69d74766aeca635594a03a2bd1f386ea5e0616a5ff4de3795e` (`pm-amm/src/idl/pm_amm.json`) |

**Why vendored.** The npm release `@pm-amm/sdk` 0.1.0 points at an old protocol DAO address.
The SDK in the repository is current, but not published.

**Copied unchanged:** `src/**` (including `src/idl/pm_amm.json`) and `tsconfig.json`, plus
`README.md` and `LICENSE`.

**Written by Horagon:**
- `package.json`: renamed `@horagon/pm-amm-vendor`, private, peer dependencies turned into
  dependencies, no lifecycle scripts. The `.` export has an extra `node` condition that points
  at the CJS build: upstream's ESM build does `import { BN } from '@anchor-lang/core'`, which
  native Node ESM rejects (that package is CommonJS and exposes `BN` through a getter that
  Node's named-export detection cannot see). Bundlers still pick the ESM build.
- `tsup.config.ts`: builds the `index` and `math` entries to ESM, CJS and `.d.ts`.

The package type-checks with its own upstream `tsconfig.json`; Biome skips `vendor/`.
`@horagon/sdk` reads the IDL in tests (error codes, instruction discriminators) and, from
Tier 1, wraps this package behind `@horagon/sdk/pm-amm`.

## Updating

1. Fetch the new upstream commit into a new, empty temporary directory (outside the repo).
2. Diff its `packages/sdk/src` against `pm-amm/src`; read the diff.
3. Copy it over, then update the commit, date and IDL hash above, and `PM_AMM_SOURCE_SHA` in
   `packages/sdk/src/pm-amm/constants.ts`.
4. `pnpm check`. The IDL consistency tests in `packages/sdk/test/pm-amm/` must pass.
