'use client'
// Buy HOME / Buy AWAY (AWAY buys NO), presets 10/50/100 or a custom amount, and Sell. Shows
// the quote's average price, price impact, the 2% fee and the shares received (spec 10). The
// logic lives in useTrade (Chronometer spec 3.3); this panel only draws it until the game
// screen moves to the crown.
import type { GameDetail, MarketSummary } from '@horagon/sdk'
import { cents, explorerTx, usdc } from '../lib/format'
import { DEFAULT_SLIPPAGE_BPS } from '../lib/trade'
import { sendDisabled, sendText, sidePrice } from '../lib/trade-view'
import { useTrade } from '../lib/use-trade'
import { ErrorText } from './error-text'
import { useWallet } from './wallet'

const PRESETS = ['10', '50', '100']

export function TradePanel({ game, market }: { game: GameDetail; market: MarketSummary }) {
  const { requestFaucet, funding, fundNote } = useWallet()
  const t = useTrade(game, market)
  const { action, side, check, ready, held, team, stage, done } = t
  const q = t.quote.data
  const price = (s: 'home' | 'away') => sidePrice(market.price, s)
  const tab = (on: boolean) =>
    `flex-1 rounded-lg py-2 font-semibold ${on ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'border border-zinc-300 dark:border-zinc-700'}`

  return (
    <section className="space-y-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex gap-2">
        <button type="button" className={tab(action === 'buy')} onClick={() => t.setAction('buy')}>
          Buy
        </button>
        <button
          type="button"
          className={tab(action === 'sell')}
          onClick={() => t.setAction('sell')}
        >
          Sell
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(['home', 'away'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={side === s}
            onClick={() => t.setSide(s)}
            className={`rounded-lg border-2 py-3 font-semibold ${
              side === s
                ? s === 'home'
                  ? 'border-home text-home'
                  : 'border-away text-away'
                : 'border-zinc-200 dark:border-zinc-800'
            }`}
          >
            {action === 'buy' ? 'Buy' : 'Sell'} {s === 'home' ? game.home : game.away}{' '}
            {cents(price(s))}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        {action === 'buy' ? (
          PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => t.setAmount(p)}
              className="rounded-lg border border-zinc-300 px-3 py-1 dark:border-zinc-700"
            >
              {p}
            </button>
          ))
        ) : (
          <button
            type="button"
            disabled={!held}
            onClick={() => held && t.setAmount(held.shares)}
            className="rounded-lg border border-zinc-300 px-3 py-1 disabled:opacity-50 dark:border-zinc-700"
          >
            Max
          </button>
        )}
        <label className="flex flex-1 items-center gap-2 rounded-lg border border-zinc-300 px-2 dark:border-zinc-700">
          <input
            inputMode="decimal"
            value={t.amount}
            onChange={(e) => t.setAmount(e.target.value)}
            aria-label={action === 'buy' ? 'mUSDC to spend' : 'Shares to sell'}
            className="w-full bg-transparent py-1 outline-none"
          />
          <span className="text-sm text-zinc-500">{action === 'buy' ? 'mUSDC' : 'shares'}</span>
        </label>
      </div>
      {q && check.quote && (
        <dl className="grid grid-cols-2 gap-y-1 text-sm">
          <dt className="text-zinc-500">
            {action === 'buy' ? 'Shares received' : 'mUSDC received'}
          </dt>
          <dd className="text-right">{usdc(q.amountOut)}</dd>
          <dt className="text-zinc-500">Average price</dt>
          <dd className="text-right">{cents(q.avgPrice)}</dd>
          <dt className="text-zinc-500">Price impact</dt>
          <dd className="text-right">{(q.priceImpactBps / 100).toFixed(2)}%</dd>
          <dt className="text-zinc-500">Fee (2%)</dt>
          <dd className="text-right">{usdc(q.feeUsdc)} mUSDC</dd>
          <dt className="text-zinc-500">Max slippage {DEFAULT_SLIPPAGE_BPS / 100}%</dt>
          <dd className="text-right">at least {usdc(q.minOut)}</dd>
        </dl>
      )}
      {action === 'buy' && (
        <p className="text-xs text-zinc-500">Each share pays 1 mUSDC if {team} wins.</p>
      )}
      {!check.ok && check.reason && (
        <p className="text-sm text-amber-600">
          {check.reason}
          {check.fund && ready === 'ready' && (
            <>
              {' '}
              <button
                type="button"
                disabled={funding}
                onClick={requestFaucet}
                className="font-semibold underline disabled:opacity-50"
              >
                {funding ? 'Requesting…' : 'Get test mUSDC'}
              </button>
            </>
          )}
        </p>
      )}
      {fundNote && !t.fundNoteHidden && <p className="text-sm text-emerald-600">{fundNote}</p>}
      <button
        type="button"
        disabled={sendDisabled(ready, check.ok, stage)}
        onClick={t.send}
        className={`w-full rounded-lg py-3 font-bold text-enamel-950 disabled:opacity-50 ${side === 'home' ? 'bg-home' : 'bg-away'}`}
      >
        {sendText(ready, stage, action, team)}
      </button>
      {done && (
        <p className="text-sm text-emerald-600">
          {done.text}{' '}
          <a
            href={explorerTx(done.signature)}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            View transaction
          </a>
        </p>
      )}
      <ErrorText error={t.shownError} />
    </section>
  )
}
