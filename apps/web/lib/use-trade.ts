'use client'
// The trade logic of the game screen (Chronometer spec 3.3), lifted out of trade-panel.tsx
// without a change: side and direction, amount, a quote debounced 300 ms, the trade-form check,
// and the send with its stages and fill line. A send goes through `withAge` (18+ gate, R1) and
// is never repeated by itself (R2). Until this signer's portfolio has loaded once, Buy and
// Sell wait, so a Buy is never checked against an unknown balance.
import {
  effectiveTime,
  type GameDetail,
  type MarketSummary,
  type Position,
  parseAmount,
  type Quote,
  type Side,
  type TradeAction,
} from '@horagon/sdk'
import type { Keypair } from '@solana/web3.js'
import { useEffect, useRef, useState } from 'react'
import { useWallet } from '../components/wallet'
import { api } from './api'
import { errorEffect } from './chrono/errors'
import { awaitFill, createFillTracker, fillLine, holding } from './fill'
import { DEFAULT_SLIPPAGE_BPS, executeTrade, type TradeStage } from './trade'
import { checkTrade, type TradeCheck, tradeReady } from './trade-form'
import { QUOTE_DEBOUNCE_MS, QUOTE_POLL_MS, quoteKey, type Ready } from './trade-view'
import { type Poll, usePoll } from './use-poll'

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export interface TradeOptions {
  /** MARKET_CLOSED or MARKET_HALTED: reload the game so the dial changes state (spec 6.1). */
  onMarketStale?: () => void
}

export interface Trade {
  side: Side
  setSide: (side: Side) => void
  action: TradeAction
  setAction: (action: TradeAction) => void
  amount: string
  setAmount: (amount: string) => void
  /** The chosen side's team. */
  team: string
  ready: Ready
  /** The wallet's position on the chosen side of this market. */
  held: Position | undefined
  balance: string | null | undefined
  check: TradeCheck
  quote: Poll<Quote>
  /** The newest quote for this side and direction, kept while the next one loads. */
  lastQuote: Quote | undefined
  /** The quote for the amount on screen has not arrived yet: the ghost dims (spec 5.5). */
  quotePending: boolean
  stage: TradeStage | null
  done: { signature: string; text: string } | null
  /** The send's own error. */
  error: unknown
  /** Unix seconds when `error` was set, for the RATE_LIMITED countdown (spec 6.1). */
  errorAt: number
  /** What ErrorText shows: the send's error, else the faucet's, else the quote's. */
  shownError: unknown
  /** The faucet note goes away once a trade starts; a new faucet request brings it back. */
  fundNoteHidden: boolean
  /** Sets up a wallet, or sends through the 18+ gate. */
  send: () => void
}

export function useTrade(game: GameDetail, market: MarketSummary, opts: TradeOptions = {}): Trade {
  const { address, portfolio, refreshPortfolio, withAge, openGate, funding, fundError } =
    useWallet()
  const [side, setSide] = useState<Side>('home')
  const [action, setAction] = useState<TradeAction>('buy')
  const [amount, setAmount] = useState('10')
  const [stage, setStage] = useState<TradeStage | null>(null)
  const alive = useRef(true)
  const fills = useRef(createFillTracker())
  const [fundNoteHidden, setFundNoteHidden] = useState(false)
  useEffect(() => {
    if (funding) setFundNoteHidden(false)
  }, [funding])
  const [error, setError] = useState<unknown>()
  const [errorAt, setErrorAt] = useState(0)
  const [done, setDone] = useState<{ signature: string; text: string } | null>(null)
  const busy = useRef(false)
  // The signature whose success line is on screen: a newer trade or a left page ends the wait.
  const shown = useRef<string | null>(null)
  const onStale = useRef(opts.onMarketStale)
  onStale.current = opts.onMarketStale
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
  const quoted = useDebounced(check.quote ? amount.trim() : null, QUOTE_DEBOUNCE_MS)
  const quote = usePoll(
    quoteKey(market.pubkey, side, action, quoted),
    () =>
      api.quote({
        market: market.pubkey,
        side,
        action,
        amount: quoted ?? '0',
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      }),
    QUOTE_POLL_MS,
  )
  const [lastQuote, setLastQuote] = useState<Quote>()
  useEffect(() => {
    if (quote.data) setLastQuote(quote.data)
  }, [quote.data])
  // A new side or direction has nothing to keep: its old ghost would point the wrong way.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on purpose when these change
  useEffect(() => setLastQuote(undefined), [side, action])

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
      const quotedOut = r.quote?.amountOut
      const line = (exact: bigint | null) => fillLine(action, team, { quoted: quotedOut, exact })
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
      setErrorAt(Date.now() / 1000)
      if (errorEffect(err) === 'refresh') onStale.current?.()
    } finally {
      busy.current = false
      setStage(null)
      refreshPortfolio()
    }
  }

  return {
    side,
    setSide,
    action,
    setAction,
    amount,
    setAmount,
    team,
    ready,
    held,
    balance: portfolio?.usdcBalance,
    check,
    quote,
    lastQuote,
    quotePending: check.quote && (quoted !== amount.trim() || quote.data === undefined),
    stage,
    done,
    error,
    errorAt,
    shownError: error ?? fundError ?? (check.quote ? quote.error : undefined),
    fundNoteHidden,
    send: () => (ready === 'no-wallet' ? openGate() : withAge((kp) => void submit(kp), 'trade')),
  }
}
