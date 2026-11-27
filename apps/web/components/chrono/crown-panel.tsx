'use client'
// The crown's content (spec 3.2, 5.5): the bezel around a dial whose ghost needle follows the
// newest quote, the numbers, presets and the amount field, and the HoldButton. It only draws a
// Trade from useTrade; the same panel is the mobile sheet and the desktop right column.
// A device that never ticked the 18+ box is asked here, inline above the send button (R5): the
// button stays off until the box is ticked, and nothing is created or sent before that. Until the
// wallet's storage has opened (the server render, the first browser render) the wallet part is a
// neutral "Loading your balance…" line: a returning visitor never sees the set-up state flash.
// The first wallet action of a page waits for the wallet's key code (R5c): its buttons say so,
// and a press on Back or a tick of the box starts that load early (R5c refix).
import type { GameDetail, MarketSummary } from '@horagon/sdk'
import { parseAmount } from '@horagon/sdk/amount'
import { useState } from 'react'
import { buySteps, percentOf, sellSteps, stepIndex } from '../../lib/chrono/bezel'
import { DISABLED, SELECTED } from '../../lib/chrono/controls'
import { dialCaption } from '../../lib/chrono/copy'
import { errorEffect, requoteShown, retryLeft } from '../../lib/chrono/errors'
import { crownLabel, type DialState } from '../../lib/chrono/state'
import { explorerTx, percent, usdc } from '../../lib/format'
import { DEFAULT_SLIPPAGE_BPS } from '../../lib/trade-shared'
import { sendDisabled, sendText } from '../../lib/trade-view'
import type { Trade } from '../../lib/use-trade'
import { FAUCET_BUTTON, WALLET_LOADING, WALLET_PREPARING } from '../../lib/wallet-copy'
import { AgeCheckbox } from '../age-dialog'
import { ErrorText } from '../error-text'
import { Bezel } from './bezel'
import { Dial } from './dial'
import { Reconnecting } from './game-screen'
import { HoldButton } from './hold-button'

const BUY_PRESETS = ['10', '25', '50', '100'] as const
const SELL_PRESETS = [25, 50, 100] as const

export interface CrownPanelProps {
  trade: Trade
  game: GameDetail
  market: MarketSummary
  state: DialState
  timeLeft: number
  /** Unix seconds from useNow, for the RATE_LIMITED countdown. */
  now: number
  funding: boolean
  /** A wallet action waits for the wallet's key code to load (WalletState.preparing). */
  preparing?: boolean
  /** A sign that a wallet action follows (a press on Buy, the 18+ box ticked): load early. */
  onIntent?: () => void
  fundNote: string | undefined
  /** The faucet; `affirmedHere` when this crown's own 18+ box is ticked. */
  onFaucet: (affirmedHere?: boolean) => void
  /**
   * The game poll is failing (spec 4.4): the crown's own dial shows it too, since the sheet
   * covers the big one on a phone.
   */
  stale?: boolean
  /**
   * Say "Reconnecting…" here as well: only in the sheet, which covers the game screen's own
   * line. Inline on desktop that line is on screen, and one status region says it once (N5).
   */
  staleLine?: boolean
}

export function CrownPanel(p: CrownPanelProps) {
  const t = p.trade
  // The inline 18+ box (R5): asked only while the device never ticked it.
  const [ticked, setTicked] = useState(false)
  const blocked = t.ageNeeded && !ticked
  const preparing = p.preparing ?? false
  const buying = t.action === 'buy'
  const steps = buying ? buySteps(t.balance) : sellSteps(t.held?.shares)
  const q = t.quote.data ?? t.lastQuote
  const effect = errorEffect(t.error)
  // SLIPPAGE_EXCEEDED: until a quote newer than the error's has come, while quotes can load.
  const requote = requoteShown(effect, t.check.quote, q, t.errorQuoteNow)
  const wait = effect === 'countdown' ? retryLeft(t.error, t.errorAt, p.now) : 0
  const label = wait > 0 ? `Try again in ${wait} s` : sendText(t.ready, t.stage, t.action, t.team)
  const ghost = q && t.check.quote ? q.priceAfter : null
  const spendable = t.balance ? parseAmount(t.balance) > 0n : false
  const tone = t.side === 'home' ? 'lume' : 'brass'
  const chip = `min-h-11 flex-1 rounded-card border border-line font-mono text-13 ${SELECTED} disabled:opacity-40`
  return (
    <div className="space-y-4">
      <Reconnecting stale={p.staleLine ?? false} />
      <fieldset className="flex gap-2">
        <legend className="sr-only">Back or sell</legend>
        <button
          type="button"
          aria-pressed={buying}
          onClick={() => t.setDirection('buy')}
          className={chip}
        >
          Back {t.team}
        </button>
        <button
          type="button"
          // After a full sell nothing is held: off, and no longer pressed.
          aria-pressed={!buying && t.held !== undefined}
          disabled={!t.held}
          onClick={() => t.setDirection('sell')}
          className={chip}
        >
          Sell {t.team}
        </button>
      </fieldset>
      <Bezel
        steps={steps}
        index={stepIndex(steps, t.amount)}
        onChange={(i) => {
          const s = steps[i]
          if (s) t.setAmount(s.amount)
        }}
        label={buying ? 'mUSDC to spend' : 'Shares to sell'}
        className="mx-auto max-w-80"
      >
        <Dial
          price={p.market.price}
          modelProb={p.game.modelProb}
          timeLeft={p.timeLeft}
          state={p.state}
          caption={dialCaption(p.state, p.game, p.market.outcome)}
          ghostPrice={ghost}
          ghostPending={t.quotePending}
          ghostShake={requote}
          stale={p.stale}
          detail={buying ? `${t.amount} mUSDC` : `${t.amount} shares`}
          label={crownLabel({
            state: p.state,
            game: p.game,
            outcome: p.market.outcome,
            price: p.market.price,
            ghost,
          })}
        />
      </Bezel>
      {q && t.check.quote && (
        <dl className="grid grid-cols-2 gap-y-1 font-mono text-13 tabular-nums">
          <dt className="font-sans text-ash-400">
            {buying ? 'Shares received' : 'mUSDC received'}
          </dt>
          <dd className="text-right">{usdc(q.amountOut)}</dd>
          <dt className="font-sans text-ash-400">Average price</dt>
          <dd className="text-right">{percent(q.avgPrice)}</dd>
          {buying && (
            <>
              <dt className="font-sans text-ash-400">If {t.team} wins</dt>
              <dd className="text-right">{usdc(q.amountOut)} mUSDC</dd>
            </>
          )}
          <dt className="font-sans text-ash-400">Price impact</dt>
          <dd className="text-right text-amber-400">{(q.priceImpactBps / 100).toFixed(2)}%</dd>
          <dt className="font-sans text-ash-400">Fee (2%)</dt>
          <dd className="text-right">{usdc(q.feeUsdc)} mUSDC</dd>
          <dt className="font-sans text-ash-400">
            Worst case (price moves {DEFAULT_SLIPPAGE_BPS / 100}%)
          </dt>
          <dd className="text-right">at least {usdc(q.minOut)}</dd>
        </dl>
      )}
      <div className="flex gap-2">
        {buying ? (
          <>
            {BUY_PRESETS.map((a) => (
              <button
                key={a}
                type="button"
                aria-pressed={t.amount === a}
                onClick={() => t.setAmount(a)}
                className={chip}
              >
                {a}
              </button>
            ))}
            <button
              type="button"
              disabled={!spendable}
              onClick={() => t.balance && t.setAmount(t.balance)}
              className={chip}
            >
              Max
            </button>
          </>
        ) : (
          SELL_PRESETS.map((pct) => {
            const a = percentOf(t.held?.shares, pct)
            return (
              <button
                key={pct}
                type="button"
                disabled={a === null}
                aria-pressed={a !== null && t.amount === a}
                onClick={() => a && t.setAmount(a)}
                className={chip}
              >
                {pct}%
              </button>
            )
          })
        )}
      </div>
      <label className="flex min-h-11 items-center gap-2 rounded-card border border-line px-3 focus-within:border-ivory-100">
        <input
          inputMode="decimal"
          value={t.amount}
          onChange={(e) => t.setAmount(e.target.value)}
          aria-label={buying ? 'mUSDC to spend' : 'Shares to sell'}
          className="w-full bg-transparent py-2 font-mono text-19 tabular-nums outline-none"
        />
        <span className="text-13 text-ash-400">{buying ? 'mUSDC' : 'shares'}</span>
      </label>
      {buying && <p className="text-12 text-ash-400">Each share pays 1 mUSDC if {t.team} wins.</p>}
      {!t.check.ok && t.check.reason && (
        <p className="text-13 text-amber-400">
          {t.check.reason}
          {t.check.fund && t.ready === 'ready' && (
            <>
              {' '}
              <button
                type="button"
                disabled={p.funding || preparing || blocked}
                onClick={() => p.onFaucet(ticked)}
                className="min-h-11 font-semibold underline disabled:opacity-50"
              >
                {p.funding ? 'Requesting…' : preparing ? WALLET_PREPARING : FAUCET_BUTTON}
              </button>
            </>
          )}
        </p>
      )}
      {p.fundNote && !t.fundNoteHidden && <p className="text-13 text-lume-300">{p.fundNote}</p>}
      {t.loaded && t.ageNeeded && (
        <AgeCheckbox
          checked={ticked}
          onChange={(on) => {
            setTicked(on)
            if (on) p.onIntent?.()
          }}
        />
      )}
      {!t.loaded ? (
        <p
          className="flex min-h-11 items-center justify-center text-13 text-ash-400"
          data-wallet-wait
        >
          {WALLET_LOADING}
        </p>
      ) : t.ready === 'no-wallet' ? (
        // Setting up a wallet trades nothing, so it takes one tap, not a hold.
        <>
          <button
            type="button"
            disabled={blocked || p.funding || preparing}
            onClick={() => t.send(ticked)}
            className={`min-h-11 w-full rounded-card px-4 text-15 font-semibold text-enamel-950 ${DISABLED} ${
              tone === 'brass' ? 'bg-brass-500' : 'bg-lume-300'
            }`}
          >
            {p.funding ? 'Getting play mUSDC…' : preparing ? WALLET_PREPARING : label}
          </button>
          <p className="text-12 text-ash-400">
            Sets up a play wallet in this browser, then you hold to call.
          </p>
        </>
      ) : (
        <HoldButton
          label={label}
          tone={tone}
          disabled={blocked || wait > 0 || sendDisabled(t.ready, t.check.ok, t.stage)}
          pending={t.stage !== null}
          onPressStart={p.onIntent}
          onConfirm={() => t.send(ticked)}
        />
      )}
      {requote && (
        <button
          type="button"
          onClick={t.quote.refresh}
          className="min-h-11 w-full rounded-card border border-amber-400/50 text-13 text-amber-400"
        >
          Get a new quote
        </button>
      )}
      {t.done && (
        <p className="text-13 text-lume-300">
          {t.done.text}{' '}
          <a
            href={explorerTx(t.done.signature)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center underline"
          >
            View transaction
          </a>
        </p>
      )}
      {/* A RATE_LIMITED wait counts down on the HoldButton: the line leaves the seconds to it. */}
      <ErrorText
        error={t.shownError}
        countdown={effect === 'countdown'}
        gameFinal={p.game.status === 'final'}
      />
    </div>
  )
}
