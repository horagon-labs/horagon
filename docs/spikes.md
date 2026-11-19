# Tier 0 spikes

Five feasibility questions answered before the core is built. Each spike writes a JSON result to
`spikes/results/<spike>-<timestamp>.json` (checks, recorded numbers, error if any); this page
summarizes the latest passing run of each (S4 has no passing run, so it uses its three probe
runs) and the decision it leads to. Spike code is throwaway. What survives: the quote function in
`@horagon/sdk/math`, the swap fixture `packages/sdk/test/fixtures/s1-swaps.json`, and the replay
fixtures in `tests/fixtures/replay/`.

Run order (each needs the previous one's wallets or funds):

```bash
pnpm --filter @horagon/spikes s5          # faucet: mUSDC for .keys/creator.json and .keys/trader.json
pnpm --filter @horagon/spikes s1          # pm-AMM lifecycle on devnet, writes the swap fixture
pnpm --filter @horagon/spikes s3b         # same lifecycle on Surfpool (start Surfpool first)
pnpm --filter @horagon/spikes s2          # CPI with a PDA authority, on Surfpool (deploy first, see S2; `s2 --cluster devnet` for devnet)
pnpm --filter @horagon/spikes s3a         # sponsored swap from a 0-SOL burner
pnpm --filter @horagon/spikes s4:probe    # feed reachability; also run by .github/workflows/feed-probe.yml
```

`s5` funds mUSDC only: the faucet's SOL reserve paid 0. Devnet SOL for `.keys/creator.json` and
`.keys/trader.json` comes from https://faucet.solana.com.

## Environment

| Tool           | Version                                         |
| -------------- | ----------------------------------------------- |
| Node           | 24.12.0 (Windows dev box), 22.23.5 (Linux host) |
| pnpm           | 10.10.0                                         |
| rustc          | 1.100.0                                         |
| solana (Agave) | 4.1.2 (see the note below)                      |
| anchor         | 1.2.2                                           |
| surfpool       | 1.7.0                                           |
| pm-AMM source  | `d5b407b6dbb83272e7dcd5b767270d5fd64786f1`      |

Rust, Solana, Anchor and Surfpool ran on a remote Ubuntu 24.04 host, the dev box has no WSL, and
`docs/dev-setup.md` has the section "Working on a remote Linux host".

Note on solana: Anchor 1.2.2's avm shim switches the active Agave release from stable 4.3.2 to
4.1.2, and on the first `anchor` run it downloads platform-tools v1.54 and v1.57 (~3.1 GB).

## Summary

| Spike | Question                                                                          | Result                                     | Result file                                                                                                                                               | Decision                                                                                                                   |
| ----- | --------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| S1    | Full pm-AMM lifecycle on devnet with the repo SDK?                                | PASS                                       | `s1-devnet-2026-11-18T09-13-42-490Z.json`                                                                                                                 | No fallback needed (S1 has none). Keep `quoteSwap` and the swap fixture.                                                   |
| S2    | Can another program's PDA be the market authority through CPI?                    | PASS (Surfpool; devnet unconfirmed)        | `s2-cpi-2026-11-18T18-29-55-177Z.json`                                                                                                                    | The program PDA is the market authority. Tier 1 opens with a devnet smoke (deploy, create, resolve; about 3 devnet SOL).   |
| S3a   | Sponsored swap from a 0-SOL burner; disallowed transactions refused?              | PASS                                       | `s3a-sponsor-2026-11-18T09-30-55-777Z.json`                                                                                                               | Players are sponsored; no SOL drip.                                                                                        |
| S3b   | Full lifecycle on a Surfpool fork of devnet, with a local mint and time travel?   | PASS                                       | `s3b-surfpool-2026-11-18T18-11-26-730Z.json`                                                                                                              | Surfpool is the local sandbox; `solana-test-validator` is not needed.                                                      |
| S4    | NBA feeds reachable from a server; one real game recorded; reference odds usable? | FAIL (NBA CDN blocked at every site tried) | `s4-probe-local-2026-11-18T09-40-20-758Z.json`<br>`s4-probe-github-actions-2026-11-18T10-13-07-656Z.json`<br>`s4-probe-vps-2026-11-19T05-21-29-979Z.json` | The second score source is ESPN plus guardian confirmation (see Decisions), and component C (reference prices) is dropped. |
| S5    | pm-AMM faucet callable from a server, 1,000 mUSDC per wallet per hour?            | PASS                                       | `s5-faucet-2026-11-18T06-02-18-766Z.json`                                                                                                                 | No fallback needed: the seed is not lowered to 300 mUSDC.                                                                  |

## S1: pm-AMM lifecycle on devnet

**Pass when** a market with `end_ts = now + 10 min` is created and seeded; all six swap
directions confirm; withdrawing all liquidity makes the next swap fail with
`InsufficientLiquidity`; resolve, `claim_winnings` and `claim_lp_residuals` confirm; every
swap's output matches `quoteSwap` within 0.1%.

| Measure                                           | Value                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `create_market` CU / fee / SOL spent (incl. rent) | 544,363 CU / 5,000 lamports / 0.03538216 SOL                                         |
| Swap CU, min–max over 6 directions                | 391,187 (yesToUsdc) – 499,776 (usdcToNo)                                             |
| Worst quote error (relative)                      | 1.06e-5 (0.0011%, noToYes); 4 of 6 swaps match exactly                               |
| Swap transaction size (bytes)                     | not recorded (the S1 result has no size for swaps; the sponsored swap in S3a is 864) |
| Halted swap error code                            | 6004 `InsufficientLiquidity` (`MARKET_HALTED`)                                       |
| Fixture                                           | `packages/sdk/test/fixtures/s1-swaps.json`, 6 swaps                                  |

## S2: PDA authority through CPI

**Pass when** the spike program signs `initialize_market` with `invoke_signed`, deposits from
its PDA's ATA, and later CPIs `resolve_market`; the invoke stack stays ≤ 5 and the
transaction fits in 1,232 bytes; a swap pays the 1% creator fee into the PDA's ATA.

| Measure                                  | Value                                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| Cluster (Surfpool / devnet)              | Surfpool (fork of devnet)                                                       |
| `create_market` CU                       | 577,046                                                                         |
| Max invoke depth                         | 4 (limit 5)                                                                     |
| Transaction size (bytes)                 | 756 (limit 1,232)                                                               |
| Rent paid by the PDA (SOL)               | 0.03537716                                                                      |
| Early resolve error code                 | 6003 `MarketNotExpired`                                                         |
| Creator fee received by the PDA treasury | 100,000 raw (0.1 units of the local 6-decimal test mint on Surfpool, not mUSDC) |

Building: on Anchor 1.2.2 the chained `anchor build && anchor keys sync && anchor build` fails.
Run three separate commands instead: `anchor build` (it creates the program keypair, then aborts
on the id mismatch), `anchor keys sync` (it exits non-zero because it changed files), and
`anchor build` again. See "Notes for Tier 1".

To reproduce on Surfpool (on the Linux host, with Surfpool running on its default RPC
`http://127.0.0.1:8899`):

```bash
cd spikes/s2-cpi
anchor build         # creates target/deploy/horagon_spike-keypair.json, then aborts on the id mismatch
anchor keys sync     # exits non-zero because it changed files
anchor build
solana-keygen new --no-bip39-passphrase -o ../../.keys/deployer.json   # only if it does not exist yet
solana airdrop 20 --keypair ../../.keys/deployer.json --url http://127.0.0.1:8899
solana program deploy target/deploy/horagon_spike.so \
  --program-id target/deploy/horagon_spike-keypair.json \
  --keypair ../../.keys/deployer.json --url http://127.0.0.1:8899
cd ../..
pnpm --filter @horagon/spikes s2
```

The driver (`spikes/src/s2-cpi.ts`) takes the program id from
`spikes/s2-cpi/target/deploy/horagon_spike-keypair.json` and first checks that an executable
program sits at that address. On Surfpool it pays with `.keys/deployer.json` (created on first use
if missing, and airdropped 20 SOL when it holds less than 5) and uses `http://127.0.0.1:8899`
unless `HORAGON_LOCAL_RPC_URL` is set. Do not commit the Anchor.toml that `anchor keys sync`
rewrites.

If S2 fails: spec §5.3 (Horagon's attestor key is the authority directly).

## S3a: sponsor route

**Pass when** a swap built for a burner wallet holding 0 SOL is co-signed by the sponsor and
confirms, and the four disallowed transactions are refused with the expected reason.

| Measure                                                          | Value                                                    |
| ---------------------------------------------------------------- | -------------------------------------------------------- |
| Sponsored swap CU / fee (lamports)                               | 506,088 CU / 10,000 lamports                             |
| Burner SOL after the swap                                        | 0 (it started at 0)                                      |
| Refusals (SPONSOR_MISUSE, PM_AMM_RULE, ATA_RULE, COMPUTE_BUDGET) | 4 of 4 refused, each with HTTP 400 and the expected code |

The four refused transactions: a SOL transfer out of the sponsor (`SPONSOR_MISUSE`),
`deposit_liquidity` (`PM_AMM_RULE`), an ATA for a stranger (`ATA_RULE`), and a CU limit above the
cap (`COMPUTE_BUDGET`).

If S3a fails: players receive a small amount of devnet SOL from the sponsor wallet when they
join.

## S3b: Surfpool sandbox

**Pass when** pm-AMM and Metaplex load from devnet on first use, a local collateral mint
works, the clock moves forward on request, and the S1 lifecycle passes end to end.

| Measure                                  | Value                                                     |
| ---------------------------------------- | --------------------------------------------------------- |
| Clock skew vs wall time at start (s)     | -4                                                        |
| Time travel works (`surfnet_timeTravel`) | Yes: the Clock sysvar moved from 1795025500 to 1795025530 |
| Lifecycle checks passed                  | 18 of 18 (4 sandbox checks and 14 lifecycle checks)       |
| Worst quote error (relative)             | 1.26e-7 (usdcToNo)                                        |

If S3b fails: `solana-test-validator` with `--clone-upgradeable-program` for pm-AMM and
Metaplex, a local mint, and short markets instead of time travel.

## S4: data sources

**Pass when** NBA CDN (scoreboard, boxscore, schedule) and ESPN are reachable from a server;
one full real game is recorded and compacted into a replay fixture; Polymarket or Kalshi
publishes NBA game prices whose terms allow display.

HTTP status of each probe, by site:

| Probe site                             | NBA scoreboard | NBA boxscore | NBA schedule | ESPN scoreboard | ESPN summary | Kalshi           | Polymarket     |
| -------------------------------------- | -------------- | ------------ | ------------ | --------------- | ------------ | ---------------- | -------------- |
| local                                  | 403            | not probed   | 403          | 200             | 200          | 200 (20 markets) | 200 (46 games) |
| github-actions                         | 403            | not probed   | 403          | 200             | 200          | not probed       | not probed     |
| vps (rented Ubuntu server, 2026-11-19) | 403            | not probed   | 403          | 200             | 200          | not probed       | not probed     |

The NBA boxscore URL needs a game id from the NBA scoreboard, which every site refused, so no run
requested it. Only the local run requested Kalshi and Polymarket; those calls were removed after
the terms were read. Fly was not tried, because there is no account.

| Item                                                                | Value                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recorded game (fixture file, frames)                                | `tests/fixtures/replay/2026-11-18-MEM-at-CLE.json`, 263 frames (MEM 124, CLE 121, final)                                                                                                                                                                                                                                                                                                              |
| Feeds agreeing on the final score                                   | ESPN only (the NBA CDN is blocked). The last frame was checked against ESPN's public box score page for the game, https://www.espn.com/nba/game/_/gameId/401910007: Final, MEM 124, CLE 121, no overtime, same line scores as the final summary record.                                                                                                                                               |
| Kalshi terms on displaying prices (read by hand, link and date)     | The Data Terms of Use (https://kalshi-public-docs.s3.amazonaws.com/kalshi-data-terms-of-service.pdf): personal, non-commercial use only, no public display, no scripted access. The Developer Agreement v1.1 (https://kalshi-public-docs.s3.amazonaws.com/Kalshi-Developer-Agreement.pdf): API use only for the member's own trading, no caching or sharing with third parties. Both read 2026-11-18. |
| Polymarket terms on displaying prices (read by hand, link and date) | The terms page (https://polymarket.com/tos) could not be fetched on 2026-11-18 (three attempts failed: the socket closed twice, then the connection was reset); its terms are unverified.                                                                                                                                                                                                             |

The recorded night had 12 games (2026-11-18 ET): 4,890 lines, 1.25 GB, recorded from 2026-11-18
23:30Z to 2026-11-19 05:41Z, with a second recorder on the VPS as a backup. The full raw
recording is not in git: it is kept git-ignored as `spikes/recordings/2026-11-18.ndjson` and
gzipped (`spikes/recordings/2026-11-18.ndjson.gz`, with a `.sha256`), with a second copy on the
remote Linux host.
`tests/fixtures/replay/` holds a fixture for each of the 12 games. Because the NBA CDN answered
403 all night, every fixture holds ESPN frames only.

The raw sample `tests/fixtures/replay/raw/2026-11-18-MEM-at-CLE.ndjson.gz` holds 20 lines (11
ESPN scoreboard, 9 ESPN summary), 176,689 bytes, with ESPN's editorial, media and odds keys
removed; each trimmed record lists what it lost in `trimmed`, and the key list is `TRIMMED_KEYS`
in `spikes/src/lib/raw-sample.ts`.

## S5: faucet

**Pass when** the pm-AMM faucet funds two wallets from a script, each with exactly 1,000
mUSDC, and a second claim within the hour is refused with 429 and `Retry-After`.

| Measure                               | Value                                                      |
| ------------------------------------- | ---------------------------------------------------------- |
| mUSDC per claim                       | 1,000 (both wallets went from 0 to exactly 1,000)          |
| SOL per claim                         | 0 (the faucet answered `sol` 0 and `solSkipped` "reserve") |
| Second claim status / Retry-After (s) | 429 / 3,596                                                |

If S5 fails: seed every market with 300 mUSDC and ask the PREDICT team for mUSDC.

## Decisions

- 2026-11-18: reference prices (component C) are dropped from the MVP, because Kalshi bars redisplay and scripted access and Polymarket's terms are unverified.
- 2026-11-18: the second score source is option (c), ESPN plus guardian confirmation with a public box score URL: the keeper reads ESPN, and every propose needs the guardian to confirm it with such a URL. Option (b), a second box score API, may come later.
- 2026-11-19: the Linux tools run on a rented Ubuntu host instead of WSL.

## Input to the Tier 1 plan

Numbers and decisions the Tier 1 plan takes from here:

- Seed per market and markets per night that the faucet supports (S5, S1 SOL cost).
  - Answer: the faucet pays 1,000 mUSDC per wallet per claim and refuses a second claim for an
    hour (S5), so the 300 mUSDC fallback seed is not needed. Creating a market costs about
    0.03538 SOL (S1: 0.03538216 SOL including the 5,000-lamport fee; S2: 0.03537716 SOL of rent
    paid by the PDA). The faucet paid no SOL in S5 (`sol` 0), so budget the rent from devnet SOL
    held in our own wallets.
  - Night budget (spec §6.3): up to 4 featured games × 1,000 mUSDC, the other games × 300 mUSDC,
    and 300 mUSDC per second-half market. A 12-game night, the size of 2026-11-18, is
    4 × 1,000 + 8 × 300 + 12 × 300 = 10,000 mUSDC, about 12,000 with the 20% target buffer: about
    12 hourly 1,000-mUSDC claims of the keeper wallet (`recycle` returns residuals). With 12–24
    markets per night, PDA rent is 0.42–0.85 SOL at 0.03538 SOL each.
- Authority model: program PDA (S2 pass) or attestor key (spec §5.3).
  - Answer: the program PDA. S2 passed on Surfpool (invoke depth 4 of 5, 756 of 1,232 bytes) but
    has not run on devnet, so Tier 1 opens with a devnet smoke (deploy, create, resolve; about
    3 devnet SOL).
- Local sandbox: Surfpool or `solana-test-validator` (S3b).
  - Answer: Surfpool 1.7.0, with a fresh process per run, because its clock only moves forward
    and persists across runs. Linux only: S3b ran on the Ubuntu host, and a Windows dev box
    without WSL depends on it.
- Player fees: sponsored or a small SOL drip (S3a).
  - Answer: sponsored. The first swap of a user on a market costs the sponsor 2,986,880
    lamports (10,000 fee + 2 × 1,488,440 YES/NO ATA rent), plus 1,488,440 once if the sponsor
    also creates the user's mUSDC ATA; repeat swaps cost about 10,000.
- Score sources the keeper reads, and whether reference odds ship (S4).
  - Answer: ESPN plus guardian confirmation (the NBA CDN answered 403 from every site tried).
    No reference odds.
- Compute-unit limit for swaps and create (S1, S2).
  - Answer: swaps 800,000 against a peak of 506,088 (S3a; the S1 peak is 499,776). Create
    1,400,000 against 577,046 through the CPI (S2; the direct create in S1 used 544,363).
  - Sponsored transactions are built by Horagon's own builder at 800,000 CU. The vendored SDK's
    `send.*` helpers attach their own limit, 1,400,000 CU for `send.swap` and
    `send.claimWinnings`, which the sponsor (cap 1,000,000) refuses with `COMPUTE_BUDGET`: Tier 1
    must not reuse them for sponsored transactions. S1's unsponsored swaps ran at 1.4M.

## Notes for Tier 1

### Sponsor route (S3a)

- Keep the order: deserialize once → validate → sign that same object → simulate with sigVerify → send that object. No re-parse between validate and sign.
- Before any RPC call: parse, verify the user's ed25519 signature locally, rate-limit on the verified signer (wallet + hashed IP), check the daily SOL cap, then validate/sign/simulate/send.
- Malformed JSON / base64 / truncated tx must return 400 INVALID_INPUT, not 500; never echo String(e) to clients.
- Check content-length and answer 413/INVALID_INPUT; throwing inside `for await (req)` resets the socket.
- Return `{ signature }` right after send (spec §9 step 3); client polls `/api/v1/tx/{sig}`. Do not await confirmation in the request.
- Map simulation errors to the spec error table (MISSING_TOKEN_ACCOUNT 3012, SLIPPAGE_EXCEEDED 6007, PROGRAM_ERROR); align the 400 body shape `{ code, reason?, detail }`.
- Measured cost (devnet, 2026-11-18): first swap of a user on a market = 10,000 fee + 2 × 1,488,440 YES/NO ATA rent = 2,986,880 lamports; +1,488,440 once if the sponsor also creates the user's mUSDC ATA; repeat swaps ≈ 10,000. Swap CU 506,088.
- Request caps do not bound spend: maxAtaCreates 5 → up to ~7.44M lamports per tx. The daily SOL cap (value not set in spec §9) is the real control; count fee and rent separately. Read getMinimumBalanceForRentExemption(165) at runtime.
- Rent on sponsor-funded ATAs comes back only from cooperative users: the user owns the ATA and can close it to themselves. The validator now ties outcome-mint ATAs to the markets the transaction trades and reports `ataCreates`; Tier 1 counts rent as spend at creation, gives each wallet/IP a daily budget of sponsored ATA creates, and flags closes of sponsor-funded ATAs whose destination is not the sponsor. Add a low-balance alert on the sponsor.
- The ok verdict reports `ataCreates` but no lamport estimate; the daily cap needs `ataCreates` × the rent read at runtime, plus the fee.
- isHoragonMarket is sync → preload Horagon markets.

### pm-AMM lifecycle (S1)

- withdraw_liquidity(all shares) closes the LpPosition and auto-claims residuals; a later claim_lp_residuals fails 3012 (AccountNotInitialized on lp_position). Expected, not a bug.
- sdk errors.ts labels 3012 MISSING_TOKEN_ACCOUNT; for claims it means the LpPosition is closed, so make the mapping context-aware.
- quoteSwap matched 6 real devnet swaps: worst 0.0011% (noToYes), 4 exact. Peak swap CU 499,776 (S1) / 506,088 (S3a) → 800k limit has headroom.

### Feeds (S4)

- espnStatus falls open on unknown states; the resolver must check state === 'post' explicitly and treat anything else as non-final.
- NBA CDN 403 also from the rented VPS (datacenter IP, 2026-11-19): blocked from home, GitHub Actions and a VPS, so a Tier 1 keeper cannot count on it from any host we run; ESPN answers 200 from all three.
- ESPN scores can go down within a game (stat corrections): GSW@DAL, HOU@IND and UTA@LAL each have a frame where a score drops (e.g. home 95 → 92) in the 2026-11-18 fixtures. The keeper, the model and replay must not assume scores only rise; settle only on state === 'post' after the guardian confirms.
- Every 2026-11-18 fixture holds ESPN frames only (NBA CDN 403 all night), so the spec §6.1 two-source Final agreement has no recorded second feed to replay; under option (c) the guardian's box score URL is the second source.

### Replay fixtures (S4)

- In 10 of 12 fixtures the clock resets to `"12:00"` within about an hour after the final whistle (20–66 min after the first final frame) while the status stays `final`.
- Clocks are `M:SS` above a minute and `S.S` below it.
- Pre-game frames carry period 0.
- The `ReplayGame`/`ReplayFrame` schema lives in the entry script `spikes/src/s4-compact.ts` and moves to a shared module before the keeper's replay mode reads the fixtures.

### Surfpool as the local sandbox (S3b)

- S3b passed 18/18 on Surfpool 1.7.0 (forking devnet): pm-AMM and Metaplex load from devnet, `surfnet_timeTravel` with `absoluteTimestamp` in ms moves the Clock sysvar, the whole lifecycle took ~73 s.
- The Surfpool clock only moves forward and persists across runs (~555 s ahead after one run). Give each test file or run a fresh Surfpool process, or derive `end_ts` and skew checks from the chain clock instead of `Date.now()`.
- Over the SSH tunnel to the VPS each transaction took ~4–5 s; on a Windows dev box without WSL, Tier 1's local loop depends on that VPS.
- Correction to the point above: the ~5 s per-transaction cadence shows up on devnet in S1 as well (swap blockTime gaps 5,5,5,5,5 on Surfpool; 10,3,5,5,5 on devnet), so it comes from the client or confirm path, not the tunnel. Profile it before budgeting Tier 1 test suites.
- On a persisted Surfpool clock a second run also mis-sizes the market: `start_ts` comes from the Clock (~wall + 555 s) while the SDK's `end_ts` is `Date.now() + 600`, leaving ~45 s of market life. Give `createMarket` an explicit `endTs` or a chain-clock `now`; check whether Surfpool has a reset cheatcode.
- Pre-warm pm-AMM and Metaplex with a `getAccountInfo` before timing-sensitive tests: a cold load fetches ~1.3–1.5 MB of ProgramData from devnet.
- S3b only tested Surfpool on Linux (VPS over a tunnel). Windows development needs WSL or a remote Linux host.

### Program PDA as pm-AMM authority (S2, Surfpool only)

- S2 passed 9/9: create + seed via PDA CPI at invoke depth 4 (limit 5), 756/1,232 bytes, ~577k CU; resolve at depth 2, 279 bytes, ~22k CU; early resolve surfaces pm-AMM 6003 through the CPI; the creator fee lands in the PDA's treasury ATA. Depth 4 leaves one level of headroom: do not wrap the create in another CPI layer.
- The PDA paid 0.03538 SOL rent per market; budget ~0.036 SOL plus a buffer, keep a monitored SOL float on the PDA, and pre-fund its mUSDC treasury ATA.
- The spike program has no access control; Tier 1's program must gate create/resolve (guardian / keeper keys) before anything reuses it.
- Anchor 1.2.2: `anchor build && anchor keys sync && anchor build` cannot be chained (first build aborts on the id mismatch; keys sync exits non-zero when it changes something). What worked: three separate commands, `anchor build` (creates the program keypair, then aborts on the id mismatch), `anchor keys sync` (exits non-zero because it changed files), `anchor build`. Whether keys sync works before any build is unverified. `keys sync` rewrites Anchor.toml (absolute wallet path, section order, one cluster only): keep the committed Anchor.toml hand-edited.
- A corrupt platform-tools v1.57 cache shows up as a rustc "Bus error" and a silent `anchor build` exit 1: clear `~/.cache/solana/v1.57`.
- Not yet verified on devnet: that run was skipped because it needs ~3 devnet SOL and the user's approval.

## Known gaps carried into Tier 1

- Sponsor route: handle policy-callback errors; never log keyed RPC URLs or stacks; the route hardening from the S3a notes (input 400s, 413, return the signature after send).
- Error mapping: make 6004 and 3012 context-aware; `errorText` falls back to `JSON.stringify` for non-Error values (simulation errors are objects); check `HoragonError` by `name`/`code`, not `instanceof` (ESM/CJS dual package); check the account owner when decoding a Market.
- Quote and math: reject or flag oversize and unfillable trades (avg price > 1); cover noToUsdc and off-center pools in the review-focus tests; fix the `cdfInv` docstring's error claim; add a Surfpool chain-parity check of quotes at 30 s and 10 s left using time travel.
- Model and evidence: finite-input checks in the win-probability model; a non-BMP key golden for JCS with the Python verifier; schema-validate `ResolutionEvidence`.
- SDK packaging: curate the root exports (no internal math helpers, `sha256`, `toHex`, `u64Le`) and add an `./errors` subpath before the first npm publish; README and LICENSE in `files`; document "build before a direct `pnpm --filter` run"; VENDOR.md accuracy.
- CI: pin actions by SHA with gitleaks and osv-scanner (spec §20.3); `pnpm audit` with an exceptions list.
- Keeper and feeds: final only on `state === 'post' && completed`; normalise clock and tip-off formats; scores can decrease; a fresh Surfpool process per test run.
