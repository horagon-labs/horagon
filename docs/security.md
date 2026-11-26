# Security

Play-money on devnet. No real value. No prizes. Horagon refuses mainnet everywhere: an RPC URL
containing "mainnet" or a mainnet genesis hash stops it. The keeper checks both before any other
RPC or database work at start-up, and `horagon-ops` before every command that signs. The API
refuses a mainnet URL when it reads its environment, and the sponsor signs nothing until the
RPC's genesis hash has shown it is not mainnet (`packages/api/src/sponsor/submit.ts`).

## Assets

- The treasury (the Authority PDA's mUSDC ATA) and the Authority's SOL.
- The sponsor's SOL.
- The attestor's SOL and mUSDC: it is also the keeper wallet that fills the treasury.
- The reference agent's SOL and mUSDC: a capped balance, spent only on its own swaps.
- Correct resolutions: a market pays the side that won the real game.
- The keys in `.keys/`, on the VPS and in Vercel.

## Keys and what each can do

| Key                          | Can                                                                                                                                  | Cannot                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Admin (`deployer.json`)      | upgrade the program, `initialize_config`, `update_config` (attestor, guardians, dispute window, creation pause), `withdraw_treasury` | —                                                       |
| Attestor (keeper, VPS)       | create markets, `halt`, `propose_result` (automatic: a Final held 60 s, from `end_ts`, checked against balldontlie)                  | challenge, finalize early, withdraw, change config      |
| Guardian 1 (`guardian.json`) | `challenge` when paged, `propose_result` by hand (a held result, after a challenge, or with auto-propose off), `halt`                | create markets, finalize early, withdraw, change config |
| Sponsor (Vercel)             | pay fees and ATA rent of allow-listed transactions                                                                                   | sign anything else (see `packages/api/src/sponsor`)     |
| Reference agent (VPS)        | sign and pay for its own swaps (each with the `horagon:bot` memo) and faucet claims                                                  | sign as the sponsor; anything a player's wallet cannot  |

`finalize` and `recycle` need no key: anyone may send them, and the program checks the market's
status and the dispute window.

A leaked attestor can propose a wrong result, halt open markets and create markets that spend
the Authority's SOL and the treasury's mUSDC. A guardian challenges a wrong result inside the
dispute window (900 s as set up in `docs/deploy.md`). The admin stops new markets with
`horagon-ops pause`, then replaces the attestor with an `update_config` transaction. `horagon-ops`
has no command for that yet, so it is built by hand with `updateConfig` from the SDK's program
client.

A leaked agent key is bounded by what the agent wallet holds: a thief can spend only its own
capped SOL and play mUSDC, and can move prices, without the memo. Stop `horagon-agent` and stop
funding it. Its trades are already outside the metric, because its wallet is listed as
`team-burner` in `docs/metrics-wallets.json`. The sponsor, attestor and treasury are not
reachable with it.

## Threats and measures

| Threat                | Measure                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sponsor farming       | Allow list per instruction; 30 tx/h per wallet and per IP hash; daily SOL cap; every user signature checked locally before any RPC call                                                                                                                                                                                                                                                        |
| Sponsor rent farming  | ATA rent counted as spend at creation; 26 new ATAs a day per wallet, 78 per IP hash; none for a wallet that closed one away outside a claim                                                                                                                                                                                                                                                    |
| Malicious API input   | zod on every input, unknown fields refused, 64 KB body limit (4 KB for `POST /api/v1/tx/submit`), problem+json errors without RPC URLs or stacks                                                                                                                                                                                                                                               |
| Wrong result          | Two-step resolution (propose, a challenge window, finalize). The attestor compares a Final with balldontlie before it proposes: a disagreement holds it and pages a guardian; a proposal no second source checked (no key, or no answer in 10 min) pages a guardian with a box-score link; a disagreement seen inside the window pages a challenge. After a challenge only a guardian proposes |
| Feed failure          | No proposal unless ESPN still shows Final at the draft's score with periods that add up; a feed silent 2 min in Q4/OT, or from S + 1h40m (80 min before `end_ts`), alerts the guardian; 10 min in Q4/OT halts the market                                                                                                                                                                       |
| Key leak through logs | Keeper and `horagon-ops` logs redact `token` and `secretKey` fields (pino); errors are logged as `errorSummary` everywhere (no stack, URLs cut to the host, 300 characters); keys never in URLs; the balldontlie key goes in a request header only, never in a log or an error                                                                                                                 |
| Supply chain          | Lockfile, pinned versions, actions pinned by commit SHA, `pnpm audit`, osv-scanner, gitleaks and `cargo audit` in CI                                                                                                                                                                                                                                                                           |

## Sponsor rent is spend

The user owns every token account the sponsor creates for them and may close it to any address,
so the rent the sponsor paid comes back only from cooperative users. Horagon never counts it as
float: the daily SOL cap charges it at creation (`getMinimumBalanceForRentExemption(165)` per
create, read once from the RPC), and the sponsor budget assumes none of it returns. A claim
never returns it: pm-AMM's `claim_winnings` burns both sides, pays the winning one, and closes
the player's YES and NO accounts itself, rent to the player, so the claim transaction carries
no close of its own. The keeper records each sponsor-paid ATA, checks every 10 minutes whether
it still exists, and alerts `ata-close:<wallet>` when one closed to an address other than the
sponsor (or to one it cannot trace), unless pm-AMM closed it inside a `claim_winnings`; the API
then opens no more accounts for that wallet. A first trade on a market costs the sponsor the
fee plus two ATAs (YES and NO), about 0.003 SOL on devnet (Tier 0, S3a).

## GitHub Actions

Every `uses:` names a commit SHA, with the tag in a comment. To move to a newer release, read
the SHA with `git ls-remote --tags https://github.com/<owner>/<repo>` (for an annotated tag,
the `^{}` line is the commit) and change both. `dtolnay/rust-toolchain` has no release tags:
it is pinned to the commit its `stable` branch pointed at, read with
`git ls-remote https://github.com/dtolnay/rust-toolchain refs/heads/stable`. Every workflow
runs with `contents: read` only.

The program workflow also pins the tools it installs, in its `env` block
(`.github/workflows/program.yml`):

- Agave `AGAVE_VERSION` (4.1.2), from its versioned installer
  `https://release.anza.xyz/v<version>/install`. It is the release Anchor 1.2.2's avm switches to
  (`docs/spikes.md`). To bump it, check the tag with
  `git ls-remote https://github.com/anza-xyz/agave refs/tags/v<version>`.
- avm, from the Anchor repository at tag `v<ANCHOR_VERSION>` (1.2.2) with `--locked`, then
  `avm install` of that version. `ANCHOR_VERSION` must match `[toolchain]` in `Anchor.toml`;
  check the tag with `git ls-remote https://github.com/solana-foundation/anchor refs/tags/v<version>`.
- cargo-audit `CARGO_AUDIT_VERSION` (0.23.0) with `--locked`. The newest release is the highest
  `cargo-audit/v*` tag of
  `git ls-remote --tags https://github.com/rustsec/rustsec 'refs/tags/cargo-audit/v*'`.

The cache key names all three versions, so a bump installs afresh.

## Accepted advisories

Two scanners run in CI. `pnpm audit --prod --audit-level high` reads its list from the root
`package.json` (`pnpm.auditConfig.ignoreGhsas`) and sees production dependencies only.
osv-scanner reads `osv-scanner.toml`, sees every package of `pnpm-lock.yaml` and `Cargo.lock`,
and fails on any advisory not listed there; each entry expires on 2027-02-19, so it is reviewed
again.

- `GHSA-3gc7-fjrx-p6mg` (bigint-buffer 1.1.5, via `@solana/spl-token`; both lists): no fixed
  release exists for the web3.js 1.x line; it decodes u64 fields of accounts returned by the
  RPC, never user input.
- `GHSA-82x6-q7mm-w9cf`, `GHSA-v5mp-jgw5-2x6j`, `GHSA-4qx8-w7c3-pj3p`, `GHSA-9j65-hcg3-gc64`,
  `GHSA-9qmh-m7c6-f92p`, `GHSA-h895-cgqg-jf52` (toml 3.0.0, via `@anchor-lang/core` in the
  pm-AMM vendor package; both lists): it parses `Anchor.toml` in tooling only.
- `GHSA-67mh-4wv8-2f99` (esbuild 0.18.20, via drizzle-kit; osv-scanner only): a devDependency of
  `packages/db` used to generate migrations; it never runs esbuild's serve mode and ships in
  nothing deployed.
- `GHSA-g7r4-m6w7-qqqr` (esbuild 0.27.7, via tsup; osv-scanner only): a devDependency of
  `packages/sdk` and its vendored pm-AMM SDK, used by the build only. The keeper runs on tsx with
  esbuild 0.28.2, which has no advisory.
- `GHSA-w5hq-g745-h8pq` (uuid 8.3.2, via `jayson` in `@solana/web3.js`; osv-scanner only):
  moderate. `v3()`, `v5()` and `v6()` skip the bounds check on an output buffer the caller
  passes (fixed in 11.1.1). jayson 4.3.0 is its only dependent and calls only `v4()`, with no
  arguments; no Horagon source imports uuid.
- `GHSA-528h-pc64-c93x` (stream-json 1.9.1, via `jayson`; osv-scanner only): moderate. The
  `pick`, `ignore`, `filter` and `replace` path filters take O(depth²) time (fixed in 3.5.0).
- `GHSA-hqr4-qq8f-hg3x` (stream-json 1.9.1; osv-scanner only): moderate. The JSONC parser and
  the verifier re-scan a comment on every chunk (fixed in 3.6.0).
- `GHSA-mjw6-4jj6-33hc` (stream-json 1.9.1; osv-scanner only): moderate. The Assembler allows
  prototype pollution through a `__proto__` key (fixed in 3.6.0).

  For all three: jayson 4.3.0 is stream-json's only dependent and requires it only in
  `lib/utils.js`. Every build of `@solana/web3.js` (Node, browser, React Native) loads
  `jayson/lib/client/browser`, which requires only `uuid` and `lib/generateRequest.js`, and
  that requires only `uuid`; no Horagon source imports stream-json.
- `RUSTSEC-2025-0141` (bincode 1.3.3; osv-scanner only): informational, unmaintained, no
  vulnerability. Its maintainers stopped development and call 1.3.3 complete. It comes in
  through `anchor-lang` 1.2.2 and the Solana crates (`solana-instruction`, `solana-sysvar`,
  `solana-zk-sdk`); the program never uses it directly.

The uuid and stream-json advisories are not in `ignoreGhsas` on purpose: they are moderate, and
`pnpm audit` fails only on high or critical. They are accepted rather than fixed because each
fix is a major version of a transitive dependency of `@solana/web3.js` 1.x, which an override
could break.

Review this list whenever a dependency is upgraded.

## Not yet covered (later tiers)

Sign-In With Solana for `/ops`, API keys, general read rate limits, CSP, a `horagon-ops`
command for `update_config` (attestor and guardians), and redaction in the API's logger. A
second guardian is not set: the config's second guardian slot is empty, and one guardian
confirms every result.
