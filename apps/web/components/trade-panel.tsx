'use client'
// Buy HOME / Buy AWAY (AWAY buys NO), presets 10/50/100 or a custom amount, and Sell. Shows
// the quote's average price, price impact, the 2% fee and the shares received (spec 10).
// A send goes through `withAge` (18+ gate, R1) and is never repeated by itself (R2): after an
// error that names a transaction, only a new click sends again. Without a wallet the button
// sets one up (a new wallet starts at the faucet); until this signer's portfolio has loaded
// once, Buy and Sell wait, so a Buy is never checked against an unknown balance.
import {
  effectiveTime,
  type GameDetail,
  type MarketSummary,
  parseAmount,
  type Side,
  type TradeAction,
} from '@horagon/sdk'
import type { Keypair } from '@solana/web3.js'
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { awaitFill, createFillTracker, fillLine, holding } from '../lib/fill'
import { cents, explorerTx, usdc } from '../lib/format'
import { DEFAULT_SLIPPAGE_BPS, executeTrade, type TradeStage } from '../lib/trade'
import { checkTrade, tradeReady } from '../lib/trade-form'
import { usePoll } from '../lib/use-poll'
import { ErrorText } from './error-text'
import { useWallet } from './wallet'

const PRESETS = ['10', '50', '100']
const STAGE_TEXT: Record<TradeStage, string> = {
  building: 'Preparing…',
  signing: 'Signing…',
  submitting: 'Sending…',
  confirming: 'Confirming…',
  requoting: 'Price moved, re-quoting…',
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export function TradePanel({ game, market }: { game: GameDetail; market: MarketSummary }) {
  const {
    address,
    portfolio,
    refreshPortfolio,
    withAge,
    openGate,
    requestFaucet,
    funding,
    fundNote,
    fundError,
  } = useWallet()
  const [side, setSide] = useState<Side>('home')
  const [action, setAction] = useState<TradeAction>('buy')
  const [amount, setAmount] = useState('10')
  const [stage, setStage] = useState<TradeStage | null>(null)
  const alive = useRef(true)
  const fills = useRef(createFillTracker())
  // The faucet note goes away once a trade starts; a new faucet request brings it back.
  const [fundNoteHidden, setFundNoteHidden] = useState(false)
  useEffect(() => {
    if (funding) setFundNoteHidden(false)
  }, [funding])
  const [error, setError] = useState<unknown>()
  const [done, setDone] = useState<{ signature: string; text: string } | null>(null)
  const busy = useRef(false)
  // The signature whose success line is on screen: a newer trade or a left page ends the wait.
  const shown = useRef<string | null>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      shown.current = null
      alive.current = false
    }
  }, [])

  const team = side === 'home' ? game.home : game.away
  const ready = tradeReady(address, portfolio)
  const held = portfolio?.positions.find((p) => p.market === market.pubkey && p.side === side)
  const check = checkTrade({
    action,
    amount,
    balance: portfolio?.usdcBalance,
    shares: held?.shares,
    marketStatus: market.status,
    endTs: market.endTs,
    nowSecs: effectiveTime(Date.now() / 1000, market.priceTs ?? 0),
  })
  const quoted = useDebounced(check.quote ? amount.trim() : null, 300)
  const quote = usePoll(
    quoted === null ? null : `quote:${market.pubkey}:${side}:${action}:${quoted}`,
    () =>
      api.quote({
        market: market.pubkey,
        side,
        action,
        amount: quoted ?? '0',
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      }),
    5_000,
  )
  const q = quote.data

  async function submit(keypair: Keypair) {
    if (busy.current || !check.ok) return
    busy.current = true
    setError(undefined)
    setDone(null)
    shown.current = null
    setFundNoteHidden(true)
    const before = holding(portfolio, keypair.publicKey.toBase58(), market.pubkey, side)
    try {
      const r = await executeTrade(
        api,
        keypair,
        {
          market: market.pubkey,
          side,
          action,
          amount: amount.trim(),
          wallet: keypair.publicKey.toBase58(),
        },
        setStage,
      )
      const quoted = r.quote?.amountOut
      const line = (exact: bigint | null) => fillLine(action, team, { quoted, exact })
      shown.current = r.signature
      setDone({ signature: r.signature, text: line(null) })
      // The line says "about" until the portfolio shows what the fill really was.
      if (r.quote) {
        const wallet = keypair.publicKey.toBase58()
        const key = `${market.pubkey}:${side}`
        // An earlier fill on this side may still be unindexed: its shares would pass for this
        // trade's, so this line stays "about". It still waits, so the next trade knows too.
        const refuse = fills.current.busy(key)
        const end = fills.current.begin(key)
        void awaitFill({
          action,
          before,
          spent: action === 'buy' ? parseAmount(amount.trim()) : 0n,
          quotedOut: parseAmount(r.quote.amountOut),
          minOut: parseAmount(r.quote.minOut),
          load: async () => holding(await api.portfolio(wallet), wallet, market.pubkey, side),
          cancelled: () => !alive.current,
        })
          .then((exact) => {
            if (!refuse && exact !== null && shown.current === r.signature) {
              setDone({ signature: r.signature, text: line(exact) })
            }
          })
          .finally(end)
      }
    } catch (err) {
      // Shown with its transaction, if it names one (ErrorText); never sent again from here.
      setError(err)
    } finally {
      busy.current = false
      setStage(null)
      refreshPortfolio()
    }
  }

  const price = (s: Side) =>
    market.price === null ? null : s === 'home' ? market.price : 1 - market.price
  const tab = (on: boolean) =>
    `flex-1 rounded-lg py-2 font-semibold ${on ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'border border-zinc-300 dark:border-zinc-700'}`

  return (
    <section className="space-y-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="flex gap-2">
        <button type="button" className={tab(action === 'buy')} onClick={() => setAction('buy')}>
          Buy
        </button>
        <button type="button" className={tab(action === 'sell')} onClick={() => setAction('sell')}>
          Sell
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {(['home', 'away'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={side === s}
            onClick={() => setSide(s)}
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
              onClick={() => setAmount(p)}
              className="rounded-lg border border-zinc-300 px-3 py-1 dark:border-zinc-700"
            >
              {p}
            </button>
          ))
        ) : (
          <button
            type="button"
            disabled={!held}
            onClick={() => held && setAmount(held.shares)}
            className="rounded-lg border border-zinc-300 px-3 py-1 disabled:opacity-50 dark:border-zinc-700"
          >
            Max
          </button>
        )}
        <label className="flex flex-1 items-center gap-2 rounded-lg border border-zinc-300 px-2 dark:border-zinc-700">
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
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
      {fundNote && !fundNoteHidden && <p className="text-sm text-emerald-600">{fundNote}</p>}
      <button
        type="button"
        disabled={ready === 'loading' || (ready === 'ready' && (!check.ok || stage !== null))}
        onClick={() =>
          ready === 'no-wallet' ? openGate() : withAge((kp) => void submit(kp), 'trade')
        }
        className={`w-full rounded-lg py-3 font-bold text-white disabled:opacity-50 ${side === 'home' ? 'bg-home' : 'bg-away'}`}
      >
        {ready === 'no-wallet'
          ? 'Set up wallet to trade'
          : ready === 'loading'
            ? 'Loading your balance…'
            : stage
              ? STAGE_TEXT[stage]
              : `${action === 'buy' ? 'Buy' : 'Sell'} ${team}`}
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
      <ErrorText error={error ?? fundError ?? (check.quote ? quote.error : undefined)} />
    </section>
  )
}
