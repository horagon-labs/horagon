'use client'
// The trade logic of the game screen (Chronometer spec 3.3), lifted out of trade-panel.tsx
// without a change: side and direction, amount, a quote debounced 300 ms, the trade-form check,
// and the send with its stages and fill line. A send goes through `withAge` (18+ gate, R1) and
// is never repeated by itself (R2). Until this signer's portfolio has loaded once, Buy and
// Sell wait, so a Buy is never checked against an unknown balance. With no wallet yet, the
// first send sets one up (R5): the crown's own 18+ box, then a new burner and the faucet, while
// the side and the amount on screen stay for the Buy that follows.
import type { GameDetail, MarketSummary, Position, Quote, Side, TradeAction } from '@horagon/sdk'
import { parseAmount } from '@horagon/sdk/amount'
import { effectiveTime } from '@horagon/sdk/math'
import type { Keypair } from '@solana/web3.js'
import { useEffect, useRef, useState } from 'react'
import { useWallet } from '../components/wallet'
import { api } from './api'
import { clearedByFaucet, errorEffect, quoteError } from './chrono/errors'
import { awaitFill, createFillTracker, fillLine, holding } from './fill'
import { checkTrade, type TradeCheck, tradeReady } from './trade-form'
import { DEFAULT_SLIPPAGE_BPS, type TradeStage } from './trade-shared'
import {
  BUY_AMOUNT,
  freshQuote,
  heldOn,
  type KeptQuote,
  keepQuote,
  QUOTE_DEBOUNCE_MS,
  QUOTE_POLL_MS,
  quoteKey,
  type Ready,
  sendDisabled,
  startAmount,
} from './trade-view'
import { type Poll, usePoll } from './use-poll'

export { BUY_AMOUNT }

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
  action: TradeAction
  /**
   * Turns the crown to `action` on `side` (default: the side on screen), with the amount that
   * direction starts from (`startAmount`). The only way to change the side or the direction.
   */
  setDirection: (action: TradeAction, side?: Side) => void
  amount: string
  setAmount: (amount: string) => void
  /** The chosen side's team. */
  team: string
  ready: Ready
  /** The wallet's position on the chosen side of this market, while it holds shares there. */
  held: Position | undefined
  balance: string | null | undefined
  check: TradeCheck
  quote: Poll<Quote>
  /** The newest quote for this side and direction, kept while the next one loads. */
  lastQuote: Quote | undefined
  /**
   * The quote for the amount on screen has not arrived yet, still debouncing or still loading:
   * the ghost dims (spec 5.5).
   */
  quotePending: boolean
  stage: TradeStage | null
  done: { signature: string; text: string } | null
  /** The send's own error. */
  error: unknown
  /** Unix seconds when `error` was set, for the RATE_LIMITED countdown (spec 6.1). */
  errorAt: number
  /**
   * The API's `now` on the quote on screen when `error` was set, -Infinity when there was none.
   * A quote with a later `now` is newer than the error, on one clock (M6, N1).
   */
  errorQuoteNow: number
  /** The direction of the send that failed with `error`; the faucet answers only a buy's. */
  failedAction: TradeAction
  /** What ErrorText shows: the send's error, else the faucet's, else the quote's. */
  shownError: unknown
  /** The faucet note goes away once a trade starts; a new faucet request brings it back. */
  fundNoteHidden: boolean
  /**
   * The wallet's browser storage was opened (false on the server and in the first render): until
   * then nothing is known of the wallet or the 18+ box, so the crown asks nothing.
   */
  loaded: boolean
  /** The 18+ box was never ticked on this device: the crown asks inline before it sends. */
  ageNeeded: boolean
  /**
   * Sends through the 18+ gate, or, with no wallet yet, sets one up and asks the faucet.
   * `affirmedHere`: the crown's own box was ticked (only `true` counts).
   */
  send: (affirmedHere?: boolean) => void
}

export function useTrade(game: GameDetail, market: MarketSummary, opts: TradeOptions = {}): Trade {
  const wallet = useWallet()
  const { address, portfolio, refreshPortfolio, withAge, requestFaucet, funding } = wallet
  const { loaded, ageNeeded, fundError } = wallet
  const [side, setSide] = useState<Side>('home')
  const [action, setAction] = useState<TradeAction>('buy')
  const [amount, setAmount] = useState(BUY_AMOUNT)
  const [stage, setStage] = useState<TradeStage | null>(null)
  const alive = useRef(true)
  const fills = useRef(createFillTracker())
  const [fundNoteHidden, setFundNoteHidden] = useState(false)
  const [error, setError] = useState<unknown>()
  const [errorAt, setErrorAt] = useState(0)
  const [errorQuoteNow, setErrorQuoteNow] = useState(Number.NEGATIVE_INFINITY)
  const [failedAction, setFailedAction] = useState<TradeAction>('buy')
  // The error as of the latest render, for the faucet effect below, which runs on `funding` only.
  const errorNow = useRef<unknown>(undefined)
  errorNow.current = error
  // A faucet request answers the send's INSUFFICIENT_FUNDS: the Pusher's buy buttons come back,
  // so a phone is not left with the faucet until a reload. Any other error stays (N6).
  useEffect(() => {
    if (funding) {
      setFundNoteHidden(false)
      if (clearedByFaucet(errorNow.current)) setError(undefined)
    }
  }, [funding])
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
  const positionOn = (s: Side) => heldOn(portfolio?.positions, market.pubkey, s)
  const held = positionOn(side)
  const check = checkTrade({
    action,
    amount,
    balance: portfolio?.usdcBalance,
    shares: held?.shares,
    marketStatus: market.status,
    gameStatus: game.status,
    endTs: market.endTs,
    nowSecs: effectiveTime(Date.now() / 1000, market.priceTs ?? 0),
  })
  const quoted = useDebounced(check.quote ? amount.trim() : null, QUOTE_DEBOUNCE_MS)
  const key = quoteKey(market.pubkey, side, action, quoted)
  const poll = usePoll(
    key,
    async () => ({
      key: key ?? '',
      quote: await api.quote({
        market: market.pubkey,
        side,
        action,
        amount: quoted ?? '0',
        slippageBps: DEFAULT_SLIPPAGE_BPS,
      }),
    }),
    QUOTE_POLL_MS,
  )
  // Only a quote loaded for this very key counts: usePoll clears its data a render late.
  const fresh = freshQuote(poll.data, key)
  const quote: Poll<Quote> = { ...poll, data: fresh }
  // The ghost's last position, adjusted while rendering so it never lags a render behind.
  const [kept, setKept] = useState<KeptQuote>()
  const nextKept = keepQuote(kept, fresh, side, action, key)
  if (nextKept !== kept) setKept(nextKept)
  const lastQuote = nextKept?.quote
  // The quote on screen as of the latest render: a send's catch runs renders after its start.
  const onScreenQuoteNow = useRef(Number.NEGATIVE_INFINITY)
  onScreenQuoteNow.current = (fresh ?? lastQuote)?.now ?? Number.NEGATIVE_INFINITY

  async function submit(keypair: Keypair) {
    if (busy.current || !check.ok) return
    busy.current = true
    setError(undefined)
    setDone(null)
    shown.current = null
    setFundNoteHidden(true)
    const before = holding(portfolio, keypair.publicKey.toBase58(), market.pubkey, side)
    try {
      // The signer loads with the first send (R5c): web3.js is not part of any page's first load.
      const { executeTrade } = await import('./trade')
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
      setErrorQuoteNow(onScreenQuoteNow.current)
      setFailedAction(action)
      if (errorEffect(err) === 'refresh') onStale.current?.()
    } finally {
      busy.current = false
      setStage(null)
      refreshPortfolio()
    }
  }

  return {
    side,
    action,
    setDirection: (next, nextSide = side) => {
      const to = { action: next, side: nextSide }
      setAmount(startAmount(to, { action, side, amount }, positionOn(nextSide)?.shares))
      setSide(nextSide)
      setAction(next)
    },
    amount,
    setAmount,
    team,
    ready,
    held,
    balance: portfolio?.usdcBalance,
    check,
    quote,
    lastQuote,
    quotePending: check.quote && (fresh === undefined || quoted !== amount.trim()),
    stage,
    done,
    error,
    errorAt,
    errorQuoteNow,
    failedAction,
    // A quote that fails on the network shows only after three polls in a row (spec 4.4).
    shownError: error ?? fundError ?? (check.quote ? quoteError(quote) : undefined),
    fundNoteHidden,
    loaded,
    ageNeeded,
    send: (affirmedHere) => {
      const ticked = affirmedHere === true
      // No burner yet: create it (the box ticked here, else the dialog asks) and fund it. A new
      // wallet cannot buy before the faucet lands, so the Buy waits for the hold that follows.
      if (ready === 'no-wallet') return requestFaucet(ticked)
      // The button's own rule, kept here for callers that skip the button (a hold gesture).
      if (sendDisabled(ready, check.ok, stage)) return
      // The wallet's key code loads with the first send (R5c): a load that fails shows here,
      // and nothing was signed or sent.
      withAge((kp) => void submit(kp), 'trade', ticked).catch((err: unknown) => {
        setError(err)
        setErrorAt(Date.now() / 1000)
        setFailedAction(action)
      })
    },
  }
}
