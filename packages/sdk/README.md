# @horagon/sdk

TypeScript SDK for Horagon: play-money prediction markets on NBA games, traded while the game
is on, on pm-AMM (Solana devnet). Play-money on devnet. No real value. No prizes.

```bash
npm install @horagon/sdk @solana/web3.js
```

## Read a market and quote a trade

```ts
import { HoragonClient } from '@horagon/sdk'

const hg = new HoragonClient({ baseUrl: 'https://<your-deployment>/api/v1' })
const [game] = await hg.games.list()
const market = game?.markets[0]
if (market) {
  const quote = await hg.quote({ market: market.pubkey, side: 'home', action: 'buy', amount: '10' })
  console.log(quote.amountOut, quote.avgPrice)
}
```

Amounts are decimal strings of mUSDC (6 decimals); prices are between 0 and 1.

## Entry points

| Import                  | What it holds                                                                 |
| ----------------------- | ----------------------------------------------------------------------------- |
| `@horagon/sdk`          | the API client, schemas, amounts, transaction builders, accounts, `quoteSwap` |
| `@horagon/sdk/errors`   | `HoragonError`, `isHoragonError`, `HORAGON_ERROR_CODES`, `errorSummary`       |
| `@horagon/sdk/client`   | `HoragonClient` alone                                                         |
| `@horagon/sdk/math`     | the pm-AMM math behind quotes                                                 |
| `@horagon/sdk/model`    | the win-probability model and Elo                                             |
| `@horagon/sdk/evidence` | RFC 8785 canonical JSON and the resolution evidence hash                      |
| `@horagon/sdk/pm-amm`   | pm-AMM accounts and instructions                                              |
| `@horagon/sdk/program`  | the Horagon program: accounts, instructions, PDAs, errors                     |
| `@horagon/sdk/replay`   | the recorded-game fixture format the keeper replays                           |

## Errors

Every failure is a `HoragonError` with a `code` (for example `SLIPPAGE_EXCEEDED`,
`RATE_LIMITED`) and often a `hint`. Test with `isHoragonError(err)`, not `instanceof`: the
package ships ESM and CommonJS builds, and an app that loads both gets two classes.

Horagon refuses mainnet. `assertNotMainnetGenesis(connection)` throws `MAINNET_DISABLED` when the
RPC reports mainnet's genesis hash (`MAINNET_GENESIS_HASH`), whatever its URL.

## Time near the end of a market

Liquidity shrinks with the square root of the time left, so a quote is only as good as its
clock. `effectiveTime(now, lastAccrualTs)` never goes back before the pool's last accrual;
`quoteSwap` and `liveMarket` use it, and so should anything that shows time left.

## License

MIT
