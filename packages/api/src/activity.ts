// Who traded a game (R2b), for the game page: the reference agent, fans, and other team or bot
// wallets. Pure: the rows come from listMarketTrades, the memo wallets from walletsWithBotMemo.
// A live display in docs/metrics.md order; `node scripts/count-fans.mjs` is the official count.
import type { TradeRow } from '@horagon/db'
import {
  formatAmount,
  type GameActivity,
  REFERENCE_AGENT_WALLET,
  type TradeTally,
} from '@horagon/sdk'

/**
 * Every `teamWallets` pubkey of docs/metrics-wallets.json, which is the source: append here when
 * it grows (test/activity.test.ts keeps the two equal). Not read at runtime, because the API runs
 * inside the apps/web Vercel function.
 */
export const TEAM_WALLETS: ReadonlySet<string> = new Set([
  'D6CYaG4YPm52oetuEy5yzXPSWsFv7yCWp2YAHeaodviR',
  'H6kzKfTP6Dq8YQmcGeL2tbNKmRSiXSpB3vpB1cyJ5jgx',
  '4fPyTjxT2haHHg28M4JRqBjVj4n3dTeEKptgFAz7mY9h',
  'AmqWjy4iVqK5RKF97YXawW7ZbGJo1U63bWF6Mo9vi9iQ',
  '32tQ3JDbnnQSqs51BDNzgcy82dW7AKK2EMKDo9ACBnrc',
  'J8npAeSbcmjiYpjQGkw4oLreJFGKRaMCVbMkCRdXi93G',
  'BpVRxrimzWvLcYr5tPDReybKKLJdgiJXXRRCZhn3f3dc',
  'BqwvXe6H4ZgCgg6D2dSDVFkCrN79X8C6ZC6RDXB5soo',
  '9qbjWVkoA4Z9SSieAcBnzG8K4zj8F3M955w7spAjK2XW',
  '9v2ZmruntFtM4HmUFNq3Nn3rpXhV3uh8FmyRWafVbcHN',
  '7Da24CpktL9Cp4st1iQ3U4ZKHgsRYXXEJx5oGbgFWP1Z',
])

/** docs/metrics.md bot rule (b), as `BOT_RATE` in scripts/count-fans.mjs. */
export const BOT_RATE = { swaps: 20, seconds: 300 } as const

/** count-fans' rule (b): some 20 of the block times (unix seconds) fall within 300 s. */
export function isRateBot(blockTimesSecs: readonly number[]): boolean {
  const times = [...blockTimesSecs].sort((a, b) => a - b)
  const span = BOT_RATE.swaps - 1
  for (let i = 0; i + span < times.length; i++) {
    if ((times[i + span] as number) - (times[i] as number) < BOT_RATE.seconds) return true
  }
  return false
}

type Bucket = 'agent' | 'fans' | 'others'
/** A bucket's running totals: raw mUSDC as bigint, so the sum is exact; the newest block time. */
interface Sum {
  swaps: number
  wallets: number
  volume: bigint
  last: number | null
}
const empty = (): Sum => ({ swaps: 0, wallets: 0, volume: 0n, last: null })

const secs = (d: Date) => Math.floor(d.getTime() / 1000)

/** docs/metrics.md order: the agent, then team, then bot, then fan. */
function bucketOf(
  wallet: string,
  swaps: TradeRow[],
  memoWallets: ReadonlySet<string>,
  agent: string,
): Bucket {
  if (wallet === agent) return 'agent'
  if (TEAM_WALLETS.has(wallet)) return 'others'
  if (memoWallets.has(wallet) || swaps.some((r) => r.botMemo === true)) return 'others'
  if (isRateBot(swaps.map((r) => secs(r.blockTime)))) return 'others'
  return 'fans'
}

/**
 * The game's swaps by class, each wallet classed once in this order: the agent (its wallet
 * exactly, whatever the memo), another listed team wallet, a bot (a `horagon:bot` swap on any
 * market, or 20 swaps on this game within 300 s), then a fan. Team and bots go to `others`.
 * A null `bot_memo` counts as false.
 */
export function gameActivity(
  rows: TradeRow[],
  memoWallets: ReadonlySet<string>,
  agent: string = REFERENCE_AGENT_WALLET,
): GameActivity {
  const byWallet = new Map<string, TradeRow[]>()
  for (const r of rows) {
    const list = byWallet.get(r.wallet)
    if (list) list.push(r)
    else byWallet.set(r.wallet, [r])
  }
  const sums: Record<Bucket, Sum> = { agent: empty(), fans: empty(), others: empty() }
  for (const [wallet, list] of byWallet) {
    const s = sums[bucketOf(wallet, list, memoWallets, agent)]
    s.wallets++
    for (const r of list) {
      s.swaps++
      s.volume += r.usdcAmount
      const t = secs(r.blockTime)
      if (s.last === null || t > s.last) s.last = t
    }
  }
  const tally = (b: Bucket): TradeTally => ({
    swaps: sums[b].swaps,
    wallets: sums[b].wallets,
    volumeUsdc: formatAmount(sums[b].volume),
  })
  return {
    agent: { ...tally('agent'), wallet: agent },
    fans: tally('fans'),
    others: tally('others'),
    lastFanTradeTs: sums.fans.last,
    lastAgentTradeTs: sums.agent.last,
  }
}
