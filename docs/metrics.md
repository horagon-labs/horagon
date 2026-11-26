# Metrics: 3-Night Fans

Play-money on devnet. No real value. No prizes.

This file pre-registers how Horagon counts its players for the Solana "Perps and Prediction
Markets" hackathon. It is committed before the first counted market of the window opens, that
is, the first counted market whose night is 2026-11-27 or later, and it is not edited after that
commit. [`scripts/count-fans.mjs`](../scripts/count-fans.mjs) implements it, and anyone can rerun
the count with Node 22 and no install:

```bash
node scripts/count-fans.mjs
```

If the script and this file ever disagree, this file wins, and the script is fixed in a public
commit that says so.

## The number

**3-Night Fans: human wallets with night touches on at least 3 different nights of the window.**
The target is at least 100, and the stretch goal is 150.

Reported next to it, for human, bot and team wallets separately:

- first-trade wallets: night touches on at least 1 night of the window;
- returning wallets: night touches on at least 2 different nights of the window;
- engaged wallets: at least 3 night touches in all, on at least 2 different games;
- for each night of the window, the number of wallets with a night touch on it and the number of
  night touches;
- wallets: every wallet with a swap on a counted market on any night, in or out of the window,
  shown for context only.

## Definitions

- **Window:** the NBA nights 2026-11-27 to 2026-12-10, as ET dates, both included. A counted
  market whose night is before the window, such as a team rehearsal or a market of the ET
  2026-11-25 night (those markets opened before this file was committed), has no night touches.
- **Counted market:** a pm-AMM market (program `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y`)
  that a `GameMarket` account of the Horagon program
  (`HtDJ3vfx8vtFSmskm2Ks39kBMuDmFZH3H2B173BB9qHF`) points to. It must also have league `NBA`, have
  kind 0 (game winner) or kind 2 (a clutch-window market, if Horagon runs them), and not be
  listed in `excludedMarkets`. Practice markets (league `PRACTICE`) and kind 1 markets never count.
- **Swap:** a top-level `swap` instruction of the pm-AMM program, in a transaction that
  succeeded, on a counted market. Each swap instruction counts once, and transactions are
  deduplicated by signature. A swap made through another program (a cross-program invocation)
  does not count.
- **Wallet:** the account that signs the swap, which is the swap's first account and must sign
  the transaction. Who pays the fee does not matter: Horagon's sponsor can pay a player's fee,
  so the fee payer may be the sponsor, not the wallet.
- **Night of a swap:** the ET date (America/New_York) of the market's scheduled tip-off, as
  recorded on chain in its `GameMarket`, never the time of the transaction. A game that tips off
  at 22:30 ET and trades after midnight stays on its night. Each market's own tip-off decides its
  night. If Horagon runs clutch-window markets, it creates each one with its game's tip-off and
  external game id, so both markets of a game share a night and count as one game.
- **Night touch:** a swap on a counted market whose night is inside the window.
- **Game:** the league plus the external game id in `GameMarket`. Markets that share both are one
  game.

## Wallet classes

Every wallet is in exactly one class. The classes are checked in this order:

1. **Team:** listed in `teamWallets` of [`metrics-wallets.json`](metrics-wallets.json). The list
   holds the keys Horagon runs with on devnet (the deployer, the attestor, the guardians, the
   sponsor and any multisig member keys), the treasury token account, the Tier 0 spike wallets
   and every burner wallet the team trades with.
   - Labels name roles, never people.
   - Entries are added in public commits and never removed.
2. **Bot:** a wallet that meets at least one of these rules:
   - **(a)** It signed a swap on a counted market, on any night, in a transaction that also
     carries a top-level SPL Memo instruction (program
     `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) with no accounts and with data exactly
     `horagon:bot`. A client can declare itself a bot this way.
   - **(b)** It made at least 20 swaps on counted markets, on any night, whose block times all
     fall inside some 300 seconds, that is within `[t, t + 300)`.

   Bots can trade. They are reported on a line of their own and never counted as fans.
3. **Human:** every other wallet.

## Excluded markets

`excludedMarkets` in [`metrics-wallets.json`](metrics-wallets.json) lists only rehearsal and test
markets of the team. Each entry has the market's `GameMarket` address, a reason and the
signature of the transaction that created it.

- The list is append-only.
- A market is added only while no wallet outside the team has swapped on it.
- Every addition after the first counted market of the window opens is explained in the devlog.

A listed market is excluded whatever its league or kind. For each excluded market, the script
prints the number of swaps that non-team wallets made on it, so anyone can see whether wallets
outside the team traded on it. Swaps on excluded markets never count toward any number above,
including the bot rules.

## Data and method

The script reads only the Solana devnet chain and the committed `metrics-wallets.json`:

1. `getProgramAccounts` on the Horagon program, filtered on the `GameMarket` discriminator,
   gives every market with its league, kind and tip-off.
2. For each counted or excluded market, `getSignaturesForAddress` on its pm-AMM market (every
   page), then `getTransaction` for each successful signature, gives the swaps.
3. The rules above give the numbers.

It uses the public devnet RPC unless it is given `--rpc <url>`. It paces its requests at 4 per
second (one every 250 ms), retries calls that are throttled, and prints how long the run took.
If a request still fails after its retries, or a listed transaction cannot be read in full, it
exits with an error instead of printing a count. It counts the swaps the RPC node returns, so a
recount needs a node that keeps the full devnet history of every counted and excluded market.

A run counts every swap the RPC node returns when it runs. Team and excluded entries apply to
every swap, whenever they were added, and both bot rules look at every swap on a counted market
up to the run, so a later run can give a different number than an earlier one. Published
numbers say when they were counted.

## What this number is not

Devnet tokens are free, so a determined person can create wallets that look human. This file
fixes the rules before the first counted market of the window opens, and the input is public
chain data that anyone can recount. Bots and team wallets are reported apart. The count still
cannot prove that each wallet is a different person.
